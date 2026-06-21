import { GoogleGenAI } from '@google/genai';
import { db } from './firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { DEFAULT_EXTRACT_KEYS, DEFAULT_CHAT_KEYS } from './defaultKeys';

const keyLastUsedTime = new Map<string, number>();
const featureCurrentIndex = new Map<string, number>();

// Feature can be 'extract' or 'chat'
export const getSafeGenAI = async (feature: 'extract' | 'chat') => {
    try {
        const docRef = doc(db, 'api_keys', feature);
        const snap = await getDoc(docRef);
        let keys: string[] = [];

        if (snap.exists()) {
            const data = snap.data();
            keys = data.keys || [];
        }

        // Merge with env keys and default hardcoded keys dynamically
        const envKeys: string[] = [];
        const baseKey = (import.meta as any).env?.VITE_GEMINI_API_KEY;
        if (baseKey) envKeys.push(baseKey);
        
        for (let i = 1; i <= 20; i++) {
            const keyUrl = (import.meta as any).env?.[`VITE_GEMINI_API_KEY_${i}`];
            if (keyUrl) envKeys.push(keyUrl);
        }
            
        const defaultKeys = feature === 'extract' ? DEFAULT_EXTRACT_KEYS : DEFAULT_CHAT_KEYS;
        keys = [...new Set([...keys, ...envKeys, ...defaultKeys])];

        if (keys.length === 0) {
           throw new Error('No API keys configured');
        }

        // Enforce a tiny 200ms cooldown to just space out very bursty parallel calls on a single key
        const now = Date.now();
        let validKeys = keys.filter(k => (now - (keyLastUsedTime.get(k) || 0)) > 200);

        if (validKeys.length === 0) {
            // Find the key that will be available first
            let oldestUsed = Number.MAX_SAFE_INTEGER;
            let bestKey = keys[0];
            for (const k of keys) {
                const usedAt = keyLastUsedTime.get(k) || 0;
                if (usedAt < oldestUsed) {
                    oldestUsed = usedAt;
                    bestKey = k;
                }
            }
            const waitTime = 200 - (now - oldestUsed);
            if (waitTime > 0 && waitTime <= 200) {
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
            validKeys = [bestKey];
        }

        // Randomly select one valid key
        const randomIndex = Math.floor(Math.random() * validKeys.length);
        const selectedKey = validKeys[randomIndex];

        // Update the use time
        keyLastUsedTime.set(selectedKey, Date.now());

        return { 
            ai: new GoogleGenAI({ apiKey: selectedKey }), 
            keyUsed: selectedKey,
            allKeys: keys,
            feature
        };
    } catch(e) {
        const envKeys: string[] = [];
        const baseKey = (import.meta as any).env?.VITE_GEMINI_API_KEY;
        if (baseKey) envKeys.push(baseKey);
        
        for (let i = 1; i <= 20; i++) {
            const keyUrl = (import.meta as any).env?.[`VITE_GEMINI_API_KEY_${i}`];
            if (keyUrl) envKeys.push(keyUrl);
        }
            
        const defaultKeys = feature === 'extract' ? DEFAULT_EXTRACT_KEYS : DEFAULT_CHAT_KEYS;
        const fallbackKeys = [...new Set([...envKeys, ...defaultKeys])];
            
        if (fallbackKeys.length > 0) {
            const fallbackKey = fallbackKeys[Math.floor(Math.random() * fallbackKeys.length)];
            keyLastUsedTime.set(fallbackKey, Date.now());
            return { ai: new GoogleGenAI({ apiKey: fallbackKey }), keyUsed: fallbackKey, feature };
        }
        throw e;
    }
};

export const generateContentWithRetry = async (feature: 'extract' | 'chat', request: any, maxRetries = 6, initialDelayMs = 1500) => {
    let delay = initialDelayMs;
    let currentAIEnv = await getSafeGenAI(feature);

    for (let i = 0; i < maxRetries; i++) {
        try {
            // Use REST API to bypass any SDK limitations in the browser
            let model = request.model || 'gemini-2.5-flash';
            if (model === 'gemini-1.5-flash-8b') {
                model = 'gemini-1.5-flash';
            }
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${currentAIEnv.keyUsed}`;
            
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: request.contents,
                    systemInstruction: request.systemInstruction,
                    generationConfig: request.config || request.generationConfig,
                    safetySettings: [
                        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                    ]
                })
            });

            const data = await res.json();

            if (!res.ok) {
                const err = new Error(data.error?.message || 'Gemini API Error');
                (err as any).status = data.error?.code || res.status;
                throw err;
            }

            const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            return { text };
            
        } catch (error: any) {
            const is503 = error?.status === "UNAVAILABLE" || error?.status === 503 || error?.message?.includes("503");
            const is429 = error?.status === "RESOURCE_EXHAUSTED" || error?.status === 429 || error?.message?.includes("429") || error?.message?.includes("quota");
            const is500 = error?.status === "INTERNAL" || error?.status === 500 || error?.message?.includes("500");
            const is404 = error?.status === "NOT_FOUND" || error?.status === 404 || error?.message?.includes("404") || error?.message?.includes("not found");
            const is403 = error?.status === 403 || error?.message?.includes("403") || error?.message?.includes("PERMISSION_DENIED");
            const is400 = error?.status === 400 || error?.message?.includes("400") || error?.message?.includes("INVALID_ARGUMENT");
            
            if ((is503 || is429 || is500 || is404 || is403 || is400) && i < maxRetries - 1) {
                // Mask the actual key to prevent exposing it in console
                const maskedKey = currentAIEnv.keyUsed.substring(0, 8) + '...';
                console.warn(`[Gemini API] Error ${error?.status || error?.message || 'API Error'} using key ${maskedKey}, retrying with next key in ${delay}ms... (Attempt ${i + 1} of ${maxRetries})`);
                
                if (is429) {
                    // Penalty for rate limited keys so it picks a different key next time
                    keyLastUsedTime.set(currentAIEnv.keyUsed, Date.now() + 60000);
                }

                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 1.5; // Exponential backoff
                
                // Rotate models on 404 or 429 or 403 or 400
                if (is429 || is404 || is403 || is400) {
                    if (request.model === 'gemini-2.5-flash') {
                        request.model = 'gemini-2.0-flash';
                    } else if (request.model === 'gemini-2.0-flash') {
                        request.model = 'gemini-1.5-flash';
                    } else if (request.model === 'gemini-1.5-flash' || request.model === 'gemini-1.5-flash-8b') {
                        request.model = 'gemini-2.5-flash';
                    } else {
                        request.model = 'gemini-2.5-flash'; // Fallback for any other custom string
                    }
                }

                currentAIEnv = await getSafeGenAI(feature);
                continue;
            }
            // Throw error with the last used config so caller can see it
            const maskedKeyForError = currentAIEnv.keyUsed.substring(0, 8) + '...';
            error.usedConfig = { keyUsed: maskedKeyForError, feature: currentAIEnv.feature };
            throw error;
        }
    }
    throw new Error('generateContentWithRetry failed');
};

export const recordKeyUsage = async (feature: string, keyUsed: string) => {
    if (keyUsed === 'env' || !keyUsed) return;
    try {
        const { increment } = await import('firebase/firestore');
        const docRef = doc(db, 'api_keys', feature);
        await setDoc(docRef, { usage: { [keyUsed]: increment(1) } }, { merge: true });
    } catch (e) {
        console.error("Failed to record key usage", e);
    }
};

export const reportFailedKey = async (feature: 'extract' | 'chat', failedKey: string) => {
    if (failedKey === 'env') return; // Cannot rotate env key
    const docRef = doc(db, 'api_keys', feature);
    const snap = await getDoc(docRef);
    if (!snap.exists()) return;
    
    const data = snap.data();
    const keys = data.keys || [];
    const currentIndex = data.currentIndex || 0;

    // If the failed key is currently the active one, rotate it
    if (keys[currentIndex] === failedKey) {
        const nextIndex = (currentIndex + 1) % keys.length;
        await setDoc(docRef, { currentIndex: nextIndex }, { merge: true });
        console.warn(`Rotated API key for ${feature} to index ${nextIndex}`);
    }
};
