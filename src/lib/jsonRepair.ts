export function safeJsonParseArray(jsonStr: string) {
  try {
    return JSON.parse(jsonStr);
  } catch (err) {
    console.warn("JSON parse failed, attempting to repair...");
    
    // First, try extracting valid objects manually (if it's an array of objects)
    const validObjects: any[] = [];
    let startIndex = jsonStr.indexOf('{');
        
    while (startIndex !== -1) {
        let braceCount = 0;
        let inString = false;
        let escapeNext = false;
        let endIndex = -1;
        
        for (let i = startIndex; i < jsonStr.length; i++) {
            const char = jsonStr[i];
            if (escapeNext) {
                escapeNext = false;
                continue;
            }
            if (char === '\\') {
                escapeNext = true;
                continue;
            }
            if (char === '"') {
                inString = !inString;
                continue;
            }
            
            if (!inString) {
                if (char === '{') braceCount++;
                if (char === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        endIndex = i;
                        break;
                    }
                }
            }
        }
        
        if (endIndex !== -1) {
            const objectStr = jsonStr.substring(startIndex, endIndex + 1);
            try {
                const parsed = JSON.parse(objectStr);
                if (parsed && typeof parsed === 'object') {
                    validObjects.push(parsed);
                }
            } catch(e) {}
            startIndex = jsonStr.indexOf('{', endIndex + 1);
        } else {
            break;
        }
    }
    
    if (validObjects.length > 0) return validObjects;

    // Fallback for array of strings (e.g. names)
    const lastValidString = jsonStr.lastIndexOf('",');
    if (lastValidString !== -1) {
        const repairedStrArray = jsonStr.substring(0, lastValidString + 1) + ']';
        try {
            return JSON.parse(repairedStrArray);
        } catch (e2) {}
    }

    throw err;
  }
}
