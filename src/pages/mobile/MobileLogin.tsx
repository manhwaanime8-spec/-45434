import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import fuzzysort from 'fuzzysort';
import { MessageCircle, Send, X, Headset } from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '@/src/lib/firebase';
import { collection, getDocs, getDoc, setDoc, doc, Timestamp, addDoc, query, where, orderBy, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { useAuth } from '../../context/AuthContext';
import { generateContentWithRetry } from '@/src/lib/gemini';
import toast from 'react-hot-toast';

import ReactMarkdown from 'react-markdown';
const BAD_WORDS = ["شتيمة", "حمار", "كلب", "غبي", "stupid", "idiot", "shit", "fuck", "bitch", "خرا", "زفت"];

const ADMINS = ["عمرو كارم محمود موسى", "محمد عبد الجواد", "محمد فكري", "محمود", "عمرو كارم محمود"];
const MASTER_PASS = "122131";



function FloatingBackground() {
  return (
    <div className="fixed inset-0 overflow-hidden pointer-events-none z-0 bg-gradient-to-br from-[#F8F9FA] to-[#E9ECEF]" />
  );
}

export default function MobileLogin() {
  const navigate = useNavigate();
  const { loginAdmin, loginStudent, studentData } = useAuth();
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [isAdminMode, setIsAdminMode] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  
  // Cinematic & Auth states
  const [showCinematic, setShowCinematic] = useState(false);
  const [cinematicName, setCinematicName] = useState('');
  const [showUnauthorized, setShowUnauthorized] = useState(false);
  const [showBan, setShowBan] = useState(false);

  // Support Chat State
  const [showSupportChat, setShowSupportChat] = useState(false);
  const [supportMessage, setSupportMessage] = useState('');
  const [supportNameInput, setSupportNameInput] = useState('');
  const [supportBankInput, setSupportBankInput] = useState('');
  const [chatMessages, setChatMessages] = useState<any[]>([]);

  const [globalSettings, setGlobalSettings] = useState<any>(null);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'admin_system', 'global_settings'), (snap) => {
        if (snap.exists()) {
            setGlobalSettings(snap.data());
        }
    });
    return () => unsub();
  }, []);

  const [deviceId, setDeviceId] = useState(() => {
    let id = localStorage.getItem('tamrediano_device_id');
    if (!id) {
        id = 'dev_' + Math.random().toString(36).substring(2, 11);
        localStorage.setItem('tamrediano_device_id', id);
    }
    return id;
  });

  const [pendingLoginStudent, setPendingLoginStudent] = useState<any>(null);
  const [pendingIp, setPendingIp] = useState<string>('');
  const [showDeviceConflict, setShowDeviceConflict] = useState(false);

  useEffect(() => {
    if (studentData) {
      const urlParams = new URLSearchParams(window.location.search);
      const bankId = urlParams.get('bank');
      navigate(bankId ? `/exam?bank=${bankId}` : '/exam', { replace: true });
    }
  }, [navigate, studentData]);

  useEffect(() => {
     if (!deviceId || !showSupportChat) return;
     const q = query(
         collection(db, 'support_chats'),
         where('deviceId', '==', deviceId),
         orderBy('createdAt', 'asc')
     );
     const unsubscribe = onSnapshot(q, (snapshot) => {
         const msgs: any[] = [];
         snapshot.forEach(doc => msgs.push({ id: doc.id, ...doc.data() }));
         setChatMessages(msgs);
     });
     return () => unsubscribe();
  }, [deviceId, showSupportChat]);

  const [isChatLoading, setIsChatLoading] = useState(false);

  const handleSendSupportMessage = async (e?: React.FormEvent, directMsg?: string) => {
      e?.preventDefault();
      const msg = directMsg || supportMessage;
      if (!msg.trim()) return;
      
      if (!directMsg) setSupportMessage('');
      
      // Bad word check
      const lowerMsg = msg.toLowerCase();
      if (BAD_WORDS.some(w => lowerMsg.includes(w))) {
          toast.error("تنبيه شديد اللهجة: يرجى احترام قواعد المحادثة وتجنب الألفاظ السيئة. الإدارة تراقب المحادثات.");
      }

      try {
          let sentMsg = msg;
          const storedName = localStorage.getItem('chatStudentName');
          let finalSenderName = name || storedName || 'مجهول التحديد';

          if (chatMessages.length === 0) {
              if (!supportNameInput.trim()) {
                  toast.error("يرجى إدخال اسمك أولاً المربع بالأعلى.");
                  return;
              }
              finalSenderName = supportNameInput.trim();
              localStorage.setItem('chatStudentName', finalSenderName);
              
              let currentIp = 'unknown';
              try {
                  const res = await fetch('https://api64.ipify.org?format=json');
                  currentIp = (await res.json()).ip;
              } catch(e) {
                 try {
                     const res2 = await fetch('https://jsonip.com/');
                     currentIp = (await res2.json()).ip;
                 } catch(e2) {}
              }
              
              sentMsg = `[معلومات الانضمام: الاسم: ${supportNameInput.trim()} | البنك: ${supportBankInput || 'غير محدد'} | IP: ${currentIp}]\n\n${msg}`;
          }

          await addDoc(collection(db, 'support_chats'), {
              deviceId,
              studentName: finalSenderName,
              message: sentMsg,
              sender: 'student',
              createdAt: serverTimestamp(),
              bankName: supportBankInput || ''
          });

          const hasRealAdminReplied = chatMessages.some(m => m.sender === 'admin' && m.studentName !== 'الدعم الفني الذكي');
          
          if (hasRealAdminReplied) return;

          // AI Response
          setIsChatLoading(true);
          try {
              let aiContextInfo = "";
              try {
                  const allowedSnap = await getDocs(collection(db, 'allowed_students'));
                  const allowedNames = allowedSnap.docs.map(d => d.data().fullName || d.data().name);
                  
                  const usersSnapList = await getDocs(collection(db, 'users'));
                  const currentUsers = usersSnapList.docs.map(d => d.data().fullName || d.data().name);

                  const allValidNames = Array.from(new Set([...allowedNames, ...currentUsers]));
                  
                  const strikesSnap = await getDocs(collection(db, 'strikes'));
                  const bannedNames = strikesSnap.docs.filter(d => d.data().banned).map(d => d.data().studentName || d.id);
                  
                  const banksSnap = await getDocs(collection(db, 'banks'));
                  const bankNames = banksSnap.docs.map(d => d.data().name);

                  aiContextInfo = `\nمعلومات هامة لمساعدتك:\nالأسماء المسجلة حالياً بالمنصة: ${allValidNames.join("، ")}\nالأسماء المحظورة: ${bannedNames.join("، ")}\nالبنوك المتاحة: ${bankNames.join("، ")}`;
              } catch (e) {
                  console.error("Context fetch failed", e);
              }

              const systemInstruction = `أنت موظف دعم فني حقيقي لمنصة "تمريضيانو"، وهي منصة تعليمية لطلاب التمريض تقدم امتحانات وتدريبات عبر "بنوك أسئلة" (Question Banks). كلمة "بنك" هنا تعني دائماً بنك أسئلة تعليمي ولا علاقة لها بالأموال أو البنوك المالية.
تحدث بلهجة مصرية طبيعية، كأنك موظف خدمة عملاء محترف ولكن ودود، بدون تكلف أو رسميات زائدة، ولا تستخدم كلمة "صاحبي" بكثرة، اجعل أسلوبك عملياً ومباشراً لمساعدة الطالب.
خطتك:
1- اقرأ (معلومات الانضمام) وتاريخ المحادثة جيداً لتعرف سياق المشكلة. الاسم الموجود في (معلومات الانضمام) هو الاسم الذي حاول الطالب الدخول به، قد يكون خاطئاً. تذكر أن الطالب لا يعرف اسمه المسجل بالمنصة ولا من قام بتسجيله، فقد استلم الرابط فقط ودخل ليكتب اسمه. أحياناً يعيقه حرف أو همزة أو نقطة. إذا لم تجد اسمه مطابقاً تماماً، ابحث عن أقرب تشابه في القائمة. إذا لم يكن اسمه واضحاً، دعه يكتب اسمه الحقيقي.
2- رحب بالطالب بأسلوب عملي، وإذا عرفت اسمه الحقيقي ناده به، ولا تسأله عن أي تفاصيل غير متعلقة بالمنصة.
3- عندما تسأله عن اسمه أو تطلب منه كتابة أي شيء، إياك أن تكتب [خيارات: ...] أبداً في هذه الرسالة، بل اتركه يكتب رده بحرية.
4- إذا أردت سؤاله عن مشكلته دون أن يكتب، اطرح عليه خيارات ليضغط عليها، واكتبها في نهاية الرد بالشكل ده: [خيارات: مشكلتي في الدخول | مشكلة في البنك | حاجة تانية].
هام جداً: ممنوع منعاً باتاً أن تطلب من الطالب كتابة شيء وتعطيه [خيارات: ...] في نفس الرسالة. استخدم وضعاً واحداً فقط.
تنبيه هام جداً: المنصة (تمريضيانو) مجانية تماماً بالكامل، لا يوجد أي مدفوعات، ولا تتحدث عن "كلمات المرور" لأن الدخول بالاسم فقط. ولا تذكر أي تفاصيل عن الـ IP أو جهازه.
5- التفكير النقدي: إذا كتب الطالب اسماً غير منطقي (مثل أرقام أو حروف مبعثرة)، اسأله بشك: "هل هذا هو اسمك الحقيقي؟".
6- البحث عن الاسم: راجع قائمة الأسماء في المعلومات المرفقة في نفس اللحظة ولا تقل أبداً "سأراجع وأرد عليك" وتصمت! إذا كان اسمه موجوداً حرفياً في القائمة المرفقة قله، وإذا لم تجده قله بصراحة أن الاسم غير مسجل واطلب منه مراجعة الإملاء.
7- يجب أن تقدم مساعدة فعلية وخطوات واضحة لحل المشكلة.
8- لا تقترح تحويله لمشرف إلا كحل أخير إذا طالت المحادثة بلا فائدة.
9- لو اتأكدت من بياناته وعايز تسجله كطالب مسموح له بالدخول، اكتب الكود ده: [تسجيل: اسمه بالكامل].
10- لحظر الطالب بسبب الشتائم، اكتب الكود ده: [حظر: اسمه بالكامل].
11- لفك حظر طالب، اكتب: [فك حظر: اسمه بالكامل].`;

              const history = chatMessages.map(m => `[${m.sender === 'student' ? 'الطالب' : 'الدعم'}]: ${m.message}`).join('\n');
              const prompt = `تاريخ المحادثة:\n${history}\n\n[الطالب]: ${msg}\n\nرد كأنك الدعم الفني الذكي:`;

              const aiRes = await generateContentWithRetry('chat', {
                  model: 'gemini-2.5-flash',
                  systemInstruction: { parts: [{ text: systemInstruction }] },
                  contents: [{ role: 'user', parts: [{ text: prompt }] }]
              });

              let replyText = aiRes.text || '';
              
              const nameMatch = replyText.match(/\[الاسم:\s*(.*?)\]/);
              if (nameMatch && nameMatch[1]) {
                  replyText = replyText.replace(nameMatch[0], '');
              }

              const regMatch = replyText.match(/\[تسجيل:\s*(.*?)\]/);
              if (regMatch && regMatch[1]) {
                  const newName = regMatch[1].trim();
                  try {
                      await addDoc(collection(db, 'allowed_students'), {
                          fullName: newName,
                          ips: [],
                          createdAt: serverTimestamp()
                      });
                  } catch (e) {}
                  replyText = replyText.replace(regMatch[0], '');
              }

              const banMatch = replyText.match(/\[حظر:\s*(.*?)\]/);
              if (banMatch && banMatch[1]) {
                  const banName = banMatch[1].trim();
                  try {
                      // Fetch current IP to ban it
                      let currentIp = '';
                      try {
                          const res = await fetch('https://api64.ipify.org?format=json');
                          currentIp = (await res.json()).ip;
                      } catch(e) {}

                      // Ban device
                      await setDoc(doc(db, 'strikes', deviceId), { count: 10, banned: true, studentName: banName }, { merge: true });
                      
                      // Ban IP
                      if (currentIp) {
                          await setDoc(doc(db, 'strikes', currentIp), { count: 10, banned: true, studentName: banName }, { merge: true });
                      }

                      const usersSnap = await getDocs(collection(db, 'users'));
                      const userDoc = usersSnap.docs.find(d => d.data().fullName === banName || d.data().name === banName);
                      if (userDoc) {
                          await setDoc(doc(db, 'strikes', userDoc.id), { count: 10, banned: true, studentName: banName }, { merge: true });
                      } else {
                          const allowedSnap = await getDocs(collection(db, 'allowed_students'));
                          const allowedDoc = allowedSnap.docs.find(d => d.data().fullName === banName || d.data().name === banName);
                          if (allowedDoc) {
                              await setDoc(doc(db, 'strikes', allowedDoc.id), { count: 10, banned: true, studentName: banName }, { merge: true });
                          }
                      }
                  } catch (e) {}
                  replyText = replyText.replace(banMatch[0], '');
              }

              const unbanMatch = replyText.match(/\[فك حظر:\s*(.*?)\]/);
              if (unbanMatch && unbanMatch[1]) {
                  const unbanName = unbanMatch[1].trim();
                  try {
                      // Unban device
                      await setDoc(doc(db, 'strikes', deviceId), { count: 0, banned: false, studentName: unbanName }, { merge: true });

                      const usersSnap = await getDocs(collection(db, 'users'));
                      const userDoc = usersSnap.docs.find(d => d.data().fullName === unbanName || d.data().name === unbanName);
                      if (userDoc) {
                          await setDoc(doc(db, 'strikes', userDoc.id), { count: 0, banned: false, studentName: unbanName }, { merge: true });
                          await setDoc(doc(db, 'users', userDoc.id), { ips: [], banned: false, currentDeviceId: '' }, { merge: true });
                      } else {
                          const allowedSnap = await getDocs(collection(db, 'allowed_students'));
                          const allowedDoc = allowedSnap.docs.find(d => d.data().fullName === unbanName || d.data().name === unbanName);
                          if (allowedDoc) {
                              await setDoc(doc(db, 'strikes', allowedDoc.id), { count: 0, banned: false, studentName: unbanName }, { merge: true });
                              await setDoc(doc(db, 'allowed_students', allowedDoc.id), { ips: [], banned: false, currentDeviceId: '' }, { merge: true });
                          }
                      }
                  } catch (e) {}
                  replyText = replyText.replace(unbanMatch[0], '');
              }

              if (replyText) {
                  await addDoc(collection(db, 'support_chats'), {
                      deviceId,
                      studentName: 'الدعم الفني الذكي',
                      message: replyText,
                      sender: 'admin',
                      createdAt: serverTimestamp()
                  });
              }
          } catch (err: any) {
              console.error("AI chat failed", err.message || err);
              // Fallback message for the user if AI hits quota limit or fails completely
              await addDoc(collection(db, 'support_chats'), {
                  deviceId,
                  studentName: 'النظام',
                  message: (err.message && err.message.includes('quota')) 
                           ? "نأسف، هناك ضغط كبير على النظام حالياً. لقد تم تحويل رسالتك للمشرف وسيقوم بالرد عليك في أقرب وقت هنا." 
                           : "عذراً، حدث خطأ تقني في الدعم الفني الذكي. لقد تم تحويل مشكلتك للمشرف.",
                  sender: 'admin',
                  createdAt: serverTimestamp()
              });
          } finally {
              setIsChatLoading(false);
          }

      } catch (err: any) {
          console.error("Failed to send message:", err.message || err);
      }
  };

  // Helper func to parse user agent
  const getDeviceName = () => {
    let dev = "كمبيوتر/لابتوب";
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('android')) dev = "هاتف أندرويد";
    if (ua.includes('ipad') || ua.includes('iphone') || ua.includes('ipod')) dev = "آيفون/آيباد";
    if (ua.includes('windows')) dev = "نظام ويندوز";
    if (ua.includes('macintosh') || ua.includes('mac os')) dev = "ماك بوك / آي ماك";
    return dev;
  };

  const getClientIp = async () => {
      const fetchWithTimeout = async (url: string, ms = 2000) => {
          const controller = new AbortController();
          const id = setTimeout(() => controller.abort(), ms);
          try {
              const res = await fetch(url, { signal: controller.signal });
              clearTimeout(id);
              return res;
          } catch(e) {
              clearTimeout(id);
              throw e;
          }
      };

      try {
          const res = await fetchWithTimeout('https://cloudflare.com/cdn-cgi/trace');
          const text = await res.text();
          const ipMatch = text.match(/ip=([^\s]+)/);
          if (ipMatch) return ipMatch[1];
      } catch (e) {
          // Ignore and fallback
      }

      try {
          const res2 = await fetchWithTimeout('https://api64.ipify.org?format=json');
          return (await res2.json()).ip;
      } catch(e2) {
          return 'unknown';
      }
  };

  const completeStudentLogin = async (student: any, currentIp: string, ips: string[]) => {
      const devInfo = getDeviceName();
      
      if (student.id !== 'dummy1') {
         setDoc(doc(db, 'users', student.id), { 
           fullName: student.fullName, 
           ips,
           lastLogin: Timestamp.now(),
           currentDeviceId: deviceId,
           deviceInfo: devInfo
         }, { merge: true }).catch(err => {
           console.error("IP update failed", err);
         });
      }

      triggerCinematic(student.fullName, () => {
        loginStudent({
          id: student.id,
          name: student.fullName,
          ip: currentIp
        });
        navigate('/exam', { replace: true });
      });
  };

  const handleConfirmLoginDeviceOverride = async () => {
      if (!pendingLoginStudent) return;
      setShowDeviceConflict(false);
      setLoading(true);
      await completeStudentLogin(pendingLoginStudent, pendingIp, pendingLoginStudent.ips || []);
      setLoading(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    
    if (!name.trim()) return;

    if (isAdminMode) {
      if (adminPassword === MASTER_PASS) {
        if (ADMINS.includes(name)) { // Admin Bypass
          loginAdmin(name);
          navigate('/admin-dashboard', { replace: true });
        } else {
          setError('يرجى التأكد من اسم المشرف أو كلمة المرور');
        }
      } else {
        setError('كلمة المرور غير صحيحة');
      }
      return;
    }

    // Student Fallback (For Testing)
    if (ADMINS.includes(name)) {
        triggerCinematic(name, () => {
          loginStudent({ id: `dummy_${name}`, name: name, ip: 'unknown' });
          const urlParams = new URLSearchParams(window.location.search);
          const bankId = urlParams.get('bank');
          navigate(bankId ? `/exam?bank=${bankId}` : '/exam', { replace: true });
        });
        return;
    }

    setLoading(true);

    try {
      const urlParams = new URLSearchParams(window.location.search);
      const bankId = urlParams.get('bank');

      let currentIp = await getClientIp();

      if (bankId) {
          const bankSnap = await getDoc(doc(db, 'banks', bankId));
          if (!bankSnap.exists()) {
              setError("بنك الأسئلة غير موجود.");
              setLoading(false);
              return;
          }
          const bankData = bankSnap.data();
          if (bankData.autoDeleteAt && bankData.autoDeleteAt < Date.now()) {
              setError("بنك الأسئلة غير موجود.");
              setLoading(false);
              return;
          }
          if (bankData.isPublic === false) {
              const allowedList = bankData.allowedNames ? bankData.allowedNames.split('\n').map((n: string) => n.trim()).filter(Boolean) : [];
              if (!allowedList.includes(name.trim())) {
                  setError("عذراً، هذا الاسم غير مسموح له بدخول هذا البنك.");
                  setShowSupportChat(true); // Open support chat for the student
                  setLoading(false);
                  return;
              }
          }
          
          // Log the entry
          try {
              await addDoc(collection(db, 'bank_entries'), {
                  bankId,
                  bankName: bankData.name,
                  studentName: name,
                  ip: currentIp,
                  createdAt: serverTimestamp()
              });
          } catch(e) {}

          triggerCinematic(name, () => {
              loginStudent({ id: `student_${Date.now()}`, name: name, ip: currentIp });
              navigate(`/exam?bank=${bankId}`, { replace: true });
          });
          return; // Skip global `allowed_students` check
      }

      const studentsRef = collection(db, 'allowed_students');
      const snapshot = await getDocs(studentsRef);
      
      const students: any[] = [];
      const now = Date.now();
      snapshot.forEach(doc => {
        const data = doc.data();
        if (data.expiresAt) {
            const expTime = data.expiresAt.toDate ? data.expiresAt.toDate().getTime() : data.expiresAt;
            if (expTime > now) {
                students.push({ id: doc.id, ...data });
            }
        } else {
            students.push({ id: doc.id, ...data });
        }
      });

      // Also check 'users' collection to maintain backward compatibility
      const usersRef = collection(db, 'users');
      const usersSnap = await getDocs(usersRef);
      usersSnap.forEach(doc => {
          students.push({ id: doc.id, ...doc.data() });
      });

      if (students.length === 0) {
        // Fallback dummy data if nothing exists yet
        students.push({ id: 'dummy1', fullName: 'عمر احمد', ips: [] });
      }

      const normalizeName = (str: string) => (str || '').replace(/أ|إ|آ/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').trim().replace(/\s+/g, ' ');
      const searchName = normalizeName(name);

      const studentsWithNorm = students.map(s => ({
          ...s,
          normName: normalizeName(s.fullName || s.name || '')
      }));

      let matchedStudent = null;
      for (const s of studentsWithNorm) {
          if (s.normName === searchName) {
              matchedStudent = s;
              break;
          }
          const wIn = searchName.split(' ').filter((w: string) => w.length > 0);
          const wReg = s.normName.split(' ').filter((w: string) => w.length > 0);
          const minLen = Math.min(wIn.length, wReg.length);
          const maxLen = Math.max(wIn.length, wReg.length);
          
          let matchCount = 0;
          for (const w of wIn) {
              if (wReg.includes(w)) matchCount++;
          }
          
          if (minLen >= 2 && matchCount >= minLen && maxLen - minLen <= 2) {
              matchedStudent = s;
              break;
          }
      }

      if (!matchedStudent) {
          const results = fuzzysort.go(searchName, studentsWithNorm, { key: 'normName', threshold: -10000 });
          if (results.length > 0 && results[0].score > -5000) {
              matchedStudent = results[0].obj;
          }
      }

      if (matchedStudent) {
        const student = matchedStudent;
        
        // Fetch real IP
        let currentIp = await getClientIp();

        const ips = student.ips || [];
        if (!ips.includes(currentIp)) {
          ips.push(currentIp);
        }

        // AUTO-BAN CHECK & STRIKES
        let isBanned = false;
        
        try {
           const devStrikeSnap = await getDoc(doc(db, 'strikes', deviceId));
           if (devStrikeSnap.exists() && devStrikeSnap.data().banned) {
               isBanned = true;
           }
           
           const ipStrikeSnap = await getDoc(doc(db, 'strikes', currentIp));
           if (ipStrikeSnap.exists() && ipStrikeSnap.data().banned) {
               isBanned = true;
           }
        } catch(e) {}

        if (student.id && student.id !== 'dummy1') {
            try {
               const strikeSnap = await getDoc(doc(db, 'strikes', student.id));
               if (strikeSnap.exists() && strikeSnap.data().banned) {
                   isBanned = true;
               }
            } catch(e){}
        }

        if (student.banned === true && !isBanned) {
            isBanned = true;
        }

        if (isBanned) {
          setShowBan(true);
          setLoading(false);
          return;
        }
        if (student.expiresAt) {
          let expiryDate: Date;
          if (student.expiresAt && typeof student.expiresAt.toDate === 'function') {
            expiryDate = student.expiresAt.toDate();
          } else {
            expiryDate = new Date(student.expiresAt);
          }
          if (expiryDate.getTime() <= Date.now()) {
            setError("عذراً، انتهت صلاحية هذا الحساب التجريبي. يرجى التواصل مع الإدارة لتجديد صلاحية دخولك للبنك.");
            setLoading(false);
            return;
          }
        }

        // Removed redundant auto-ban check

        // Device Binding check
        if (student.currentDeviceId && student.currentDeviceId !== deviceId && student.id !== 'dummy1') {
            setPendingLoginStudent(student);
            setPendingIp(currentIp);
            setShowDeviceConflict(true);
            setLoading(false);
            return;
        }

        await completeStudentLogin(student, currentIp, ips);

      } else {
        if (globalSettings?.allow_all_names) {
            let currentIp = await getClientIp();
            const newId = `student_${Date.now()}`;
            try {
                setDoc(doc(db, 'users', newId), {
                    fullName: name,
                    name: name,
                    ips: [currentIp],
                    lastLogin: serverTimestamp(),
                    lastActive: serverTimestamp(),
                    deviceId: deviceId,
                    currentDeviceId: deviceId,
                    deviceInfo: navigator.userAgent
                });
            } catch(e) {}
            
            triggerCinematic(name, () => {
              loginStudent({ id: newId, name: name, ip: currentIp });
              const currentBank = (new URLSearchParams(window.location.search)).get('bank');
              navigate(currentBank ? `/exam?bank=${currentBank}` : '/exam', { replace: true });
            });
            return;
        }
        setShowUnauthorized(true);
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, 'allowed_students');
      setError('حدث خطأ في الاتصال بقاعدة البيانات.');
    }
    setLoading(false);
  };

  const triggerCinematic = (fullName: string, callback: () => void) => {
     setCinematicName(fullName);
     setShowCinematic(true);
     setTimeout(() => {
        callback();
     }, 2500); // Cinematic duration
  };

  const handleAccessRequest = async () => {
    setLoading(true);
    try {
        let currentIp = await getClientIp();

        await setDoc(doc(collection(db, 'accessRequests')), {
            requestedName: name,
            ipAddress: currentIp,
            status: 'pending',
            createdAt: Timestamp.now() // Use the actual message logic here or redirect to a chat
        });

        alert('تم إرسال طلبك لللإدارة.');
        setShowUnauthorized(false);
        setName('');
    } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, 'accessRequests');
        setError('حدث خطأ أثناء إرسال الطلب.');
    }
    setLoading(false);
  };

  if (showCinematic) {
    return (
      <div className="fixed inset-0 bg-[#F8F9FA] flex flex-col items-center justify-center z-50">
         <motion.div 
            initial={{ opacity: 0, scale: 0.8, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 1, ease: 'easeOut' }}
            className="text-center"
         >
            <h1 className="text-7xl font-serif italic text-[#D4AF37] tracking-wider mb-6 drop-shadow-md" style={{ fontFamily: '"Aref Ruqaa", serif' }}>تمريضيانو</h1>
            <motion.p 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.8, duration: 1 }}
              className="text-gray-600 text-xl font-bold"
            >
              أهلاً بك، <span className="text-[#D4AF37]">{cinematicName}</span>...
            </motion.p>
         </motion.div>
      </div>
    );
  }

  if (showBan) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#F8F9FA] text-[#1A1A1A] p-6 font-sans rtl relative">
         <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="w-full max-w-md bg-white rounded-3xl shadow-2xl p-8 border border-red-100 text-center z-10">
            <div className="w-20 h-20 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-6">
               <span className="text-red-500 text-4xl">🚫</span>
            </div>
            <h2 className="text-2xl font-bold text-red-600 mb-4">حسابك محظور</h2>
            <p className="text-gray-600 mb-8 leading-relaxed font-medium">تم إيقاف حسابك لتجاوز الحد المسموح من الأجهزة (أكثر من 3) أو لمخالفة القواعد. يرجى التواصل مع الإدارة.</p>
            <div className="flex flex-col gap-3">
               <button onClick={() => setShowSupportChat(true)} className="w-full bg-[#1A1A1A] text-white font-bold py-3 rounded-xl hover:bg-black transition-colors flex items-center justify-center gap-2">
                 <MessageCircle size={18} /> تواصل مع الإدارة الآن
               </button>
               <button onClick={() => setShowBan(false)} className="bg-gray-100 text-gray-700 font-bold py-3 px-6 rounded-xl hover:bg-gray-200 transition-all">عودة للخلف</button>
            </div>
         </motion.div>

         {/* Support Chat Window */}
         <AnimatePresence>
           {showSupportChat && (
              <motion.div 
                initial={{ opacity: 0, y: 50, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 50, scale: 0.9 }}
                className="fixed bottom-2 left-2 right-2 sm:bottom-6 sm:left-auto sm:right-6 w-auto sm:w-96 max-w-none sm:max-w-md bg-white rounded-2xl shadow-2xl border border-gray-200 z-[60] flex flex-col overflow-hidden h-[85vh] sm:h-[500px]"
              >
                 {/* Header */}
                 <div className="bg-gray-900 text-white p-4 flex justify-between items-center shadow-md">
                    <div className="flex items-center gap-3">
                       <div className="bg-gray-800 p-2 rounded-full"><Headset size={20} className="text-[#D4AF37]"/></div>
                       <div>
                           <h3 className="font-bold text-sm">الدعم الفني الذكي</h3>
                           <p className="text-[10px] text-gray-400">متواجدون لمساعدتك في حال وجود مشكلة</p>
                       </div>
                    </div>
                    <button onClick={() => setShowSupportChat(false)} className="text-gray-400 hover:text-white transition-colors bg-gray-800 p-1.5 rounded-full"><X size={16} /></button>
                 </div>

                 {/* Chat Area */}
                 <div className="flex-1 bg-[#F8F9FA] p-4 overflow-y-auto flex flex-col gap-3">
                    <div className="text-center my-2">
                       <span className="bg-blue-50 text-blue-700 text-[10px] font-bold px-3 py-1 rounded-full border border-blue-100">بادر بإرسال مشكلتك بوضوح أو اختر من أدناه</span>
                    </div>
                    {chatMessages.length === 0 && (
                      <div className="flex flex-col gap-2 mt-2 px-2">
                         <div className="bg-white p-3 rounded-2xl border border-blue-100 shadow-sm flex flex-col gap-2 mb-2">
                             <p className="text-[10px] text-blue-700 font-bold mb-1">بيانات تواصل الإدارة (أكملها قبل الإرسال):</p>
                             <input 
                                value={supportNameInput}
                                onChange={e => setSupportNameInput(e.target.value)}
                                placeholder="الاسم ثلاثي (إجباري)*"
                                className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-xs focus:border-[#D4AF37] outline-none"
                             />
                             <input 
                                value={supportBankInput}
                                onChange={e => setSupportBankInput(e.target.value)}
                                placeholder="البنك الذي تحاول الدخول إليه (اختياري)"
                                className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-xs focus:border-[#D4AF37] outline-none"
                             />
                         </div>
                         <button type="button" onClick={(e) => handleSendSupportMessage(e, "مشكلة في التسجيل أو الدخول")} className="bg-white border border-gray-200 p-3 rounded-xl text-xs font-bold text-gray-700 hover:border-[#D4AF37] hover:text-[#D4AF37] text-right transition-colors shadow-sm">مشكلة في التسجيل أو الدخول</button>
                         <button type="button" onClick={(e) => handleSendSupportMessage(e, "مشكلة في بنوك الأسئلة")} className="bg-white border border-gray-200 p-3 rounded-xl text-xs font-bold text-gray-700 hover:border-[#D4AF37] hover:text-[#D4AF37] text-right transition-colors shadow-sm">مشكلة في بنوك الأسئلة</button>
                         <button type="button" onClick={(e) => handleSendSupportMessage(e, "مشكلة أخرى")} className="bg-white border border-gray-200 p-3 rounded-xl text-xs font-bold text-gray-700 hover:border-[#D4AF37] hover:text-[#D4AF37] text-right transition-colors shadow-sm">مشكلة أخرى</button>
                      </div>
                    )}
                    {chatMessages.map(msg => {
                       let text = msg.message;
                       let options: string[] = [];
                       const optionsMatch = text.match(/\[خيارات:\s*(.*?)\]/);
                       if (optionsMatch) {
                          options = optionsMatch[1].split('|').map((o: string) => o.trim());
                          text = text.replace(optionsMatch[0], '');
                       }
                       return (
                         <div key={msg.id} className={`flex flex-col gap-1 ${msg.sender === 'student' ? 'items-end' : 'items-start'}`}>
                            <div className={`max-w-[80%] p-3 rounded-2xl text-sm ${msg.sender === 'student' ? 'bg-[#D4AF37] text-white rounded-br-sm shadow-md' : 'bg-white border border-gray-200 text-gray-800 rounded-bl-sm shadow-sm leading-relaxed'}`}>
                                <div className="markdown-body">
                                    <ReactMarkdown>{text.trim()}</ReactMarkdown>
                                </div>
                            </div>
                            {options.length > 0 && msg.id === chatMessages[chatMessages.length - 1].id && (
                               <div className="flex flex-col gap-2 mt-2 w-full max-w-[80%]">
                                   {options.map((opt, idx) => (
                                      <button key={idx} type="button" onClick={(e) => handleSendSupportMessage(e, opt)} className="bg-white border border-gray-200 p-2.5 rounded-xl text-xs font-bold text-gray-700 hover:border-[#D4AF37] hover:text-[#D4AF37] text-right transition-colors shadow-sm flex items-center justify-between">
                                         <span>{opt}</span>
                                      </button>
                                   ))}
                               </div>
                            )}
                         </div>
                       );
                    })}
                 </div>

                 {/* Input Area */}
                 <div className="p-3 bg-white border-t border-gray-100">
                    <form onSubmit={handleSendSupportMessage} className="flex gap-2">
                       <input 
                          value={supportMessage}
                          onChange={e => setSupportMessage(e.target.value)}
                          placeholder="اكتب رسالتك للإدارة هنا..."
                          className="flex-1 bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:border-[#D4AF37] outline-none"
                       />
                       <button type="submit" disabled={!supportMessage.trim()} className="bg-[#1A1A1A] hover:bg-black text-white w-12 flex items-center justify-center rounded-xl transition-colors disabled:opacity-50"><Send size={18} /></button>
                    </form>
                 </div>
              </motion.div>
           )}
         </AnimatePresence>
      </div>
    );
  }

  if (showUnauthorized) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#F8F9FA] text-[#1A1A1A] p-6 font-sans rtl">
         <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="w-full max-w-md bg-white rounded-3xl shadow-2xl p-8 border border-gray-100 text-center">
            <h2 className="text-3xl font-serif text-gray-800 mb-4" style={{ fontFamily: '"Aref Ruqaa", serif' }}>عذراً، غير مصرح لك!</h2>
            <p className="text-gray-600 mb-8 leading-relaxed font-medium">الاسم <span className="font-bold text-[#D4AF37]">{name}</span> غير مسجل في قوائم الدفعة المعتمدة للوصول لهذه المنصة.</p>
            <div className="flex flex-col gap-3">
               <button onClick={() => { setShowUnauthorized(false); setShowSupportChat(true); }} className="w-full bg-[#D4AF37] text-white font-bold py-4 rounded-xl shadow-lg hover:shadow-xl transition-all">تواصل مع الدعم الفني</button>
               <button onClick={() => setShowUnauthorized(false)} className="w-full bg-white border border-gray-200 text-gray-600 font-bold py-4 rounded-xl hover:bg-gray-50 transition-all">رجوع</button>
            </div>
         </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[#F8F9FA] text-[#1A1A1A] p-6 font-sans overflow-hidden relative" dir="rtl">
      <FloatingBackground />
      <motion.div 
        initial={{ opacity: 0, scale: 0.85, y: 40 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-md bg-white/95 backdrop-blur-xl rounded-3xl shadow-[0_20px_60px_-15px_rgba(0,0,0,0.1)] p-8 border border-white/50 z-10 relative"
      >
        <div className="text-center mb-8">
          <h1 className="text-5xl font-serif italic text-[#D4AF37] tracking-wider mb-2 select-none drop-shadow-sm flex items-center justify-center gap-2" style={{ fontFamily: '"Aref Ruqaa", serif' }}>
            <span>تمريضيانو</span>
          </h1>
          <p className="text-xs uppercase tracking-[0.2em] text-gray-400 font-bold">بوابة الدخول الموحدة</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="relative">
            <div className="absolute inset-y-0 right-0 pr-4 flex items-center pointer-events-none text-xl opacity-80">
               👤
            </div>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={isAdminMode ? "الاسم الثلاثي للمشرف" : "الاسم الثلاثي للطالب"}
              className="w-full pr-12 pl-5 py-4 rounded-xl border border-gray-200 bg-gray-50/50 placeholder-gray-400 focus:outline-none focus:border-[#D4AF37] focus:ring-2 focus:ring-[#D4AF37]/30 text-gray-900 transition-all text-right text-sm font-bold shadow-sm"
              required
            />
          </div>

          <AnimatePresence>
            {isAdminMode && (
              <motion.div
                initial={{ opacity: 0, height: 0, y: -10 }}
                animate={{ opacity: 1, height: 'auto', y: 0 }}
                exit={{ opacity: 0, height: 0, y: -10 }}
                transition={{ duration: 0.3 }}
                className="overflow-hidden"
              >
                <div className="pt-2">
                  <div className="relative">
                    <div className="absolute inset-y-0 right-0 pr-4 flex items-center pointer-events-none text-xl opacity-80">
                      🔒
                    </div>
                    <input
                      type="password"
                      value={adminPassword}
                      onChange={(e) => setAdminPassword(e.target.value)}
                      placeholder="كلمة المرور للإدارة"
                      className="w-full pr-12 pl-5 py-4 rounded-xl border border-gray-200 bg-gray-50/50 placeholder-gray-400 focus:outline-none focus:border-[#D4AF37] focus:ring-2 focus:ring-[#D4AF37]/30 text-gray-900 transition-all text-center text-sm font-mono tracking-widest shadow-sm"
                      required={isAdminMode}
                    />
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {error && <p className="text-red-600 text-xs text-center font-bold py-2 bg-red-50 rounded-lg border border-red-100">{error}</p>}

          <button
            type="submit"
            disabled={loading || !name.trim()}
            className="w-full bg-gradient-to-r from-[#D4AF37] to-[#B3932F] text-white text-sm font-bold py-4 rounded-xl shadow-[0_8px_20px_-6px_rgba(212,175,55,0.4)] hover:shadow-[0_12px_24px_-6px_rgba(212,175,55,0.6)] hover:-translate-y-0.5 transition-all duration-300 disabled:opacity-50 disabled:transform-none mt-4"
          >
            {loading ? 'جاري التحقق...' : (isAdminMode ? 'دخول الإدارة' : 'دخول المنصة')}
          </button>
        </form>

        <div className="mt-8 text-center pt-6 border-t border-gray-100">
           <button 
             onClick={() => setIsAdminMode(!isAdminMode)}
             type="button"
             className="text-xs font-bold text-gray-400 hover:text-[#D4AF37] transition-colors bg-transparent border-none outline-none cursor-pointer select-none flex items-center justify-center mx-auto gap-2"
           >
             {isAdminMode ? 'العودة كطالب' : 'دخول الإدارة'}
           </button>
        </div>

      </motion.div>

      <AnimatePresence>
        {showDeviceConflict && (
           <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
             <motion.div 
               initial={{ opacity: 0, scale: 0.95, y: 20 }}
               animate={{ opacity: 1, scale: 1, y: 0 }}
               className="bg-white p-8 rounded-3xl max-w-sm w-full text-center border-2 border-orange-200 shadow-2xl space-y-6"
             >
               <div className="w-20 h-20 bg-orange-50 rounded-full flex items-center justify-center mx-auto">
                 <svg className="w-10 h-10 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                 </svg>
               </div>
               <div>
                  <h3 className="text-xl font-bold text-gray-900 mb-2">تنبيه: الحساب قيد الاستخدام</h3>
                  <p className="text-sm text-gray-500 leading-relaxed font-medium">الاسم مسجل ومُستخدم في جهاز آخر حالياً. هل تريد تسجيل الخروج من الجهاز الآخر والدخول من هذا الحساب؟</p>
               </div>
               <div className="flex gap-3 pt-2">
                  <button onClick={() => { setShowDeviceConflict(false); setPendingLoginStudent(null); }} className="flex-1 px-4 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold rounded-xl transition-colors">إلغاء</button>
                  <button onClick={handleConfirmLoginDeviceOverride} className="flex-1 px-4 py-3 bg-orange-500 hover:bg-orange-600 text-white font-bold rounded-xl shadow-lg shadow-orange-500/30 transition-all">نعم، متأكد</button>
               </div>
             </motion.div>
           </div>
        )}
      </AnimatePresence>

      {/* Support Chat Floating Button */}
      {!showSupportChat && (
          <button 
             onClick={() => setShowSupportChat(true)}
             className="fixed bottom-6 right-6 w-14 h-14 bg-[#D4AF37] text-white rounded-full flex items-center justify-center shadow-2xl hover:bg-[#C5A059] transition-all hover:scale-110 z-50 group hover:shadow-[#D4AF37]/50"
             title="تواصل مع الإدارة"
          >
             <MessageCircle size={28} />
             <span className="absolute -top-10 right-0 bg-gray-900 text-white text-xs font-bold px-3 py-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap shadow-lg">واجهت مشكلة؟ المحادثة مع الدعم الفني</span>
          </button>
      )}

      {/* Support Chat Window */}
      <AnimatePresence>
        {showSupportChat && (
           <motion.div 
             initial={{ opacity: 0, y: 50, scale: 0.9 }}
             animate={{ opacity: 1, y: 0, scale: 1 }}
             exit={{ opacity: 0, y: 50, scale: 0.9 }}
             className="fixed bottom-2 left-2 right-2 sm:bottom-6 sm:left-auto sm:right-6 w-auto sm:w-96 max-w-none sm:max-w-md bg-white rounded-2xl shadow-2xl border border-gray-200 z-[60] flex flex-col overflow-hidden h-[85vh] sm:h-[500px]"
           >
              {/* Header */}
              <div className="bg-gray-900 text-white p-4 flex justify-between items-center shadow-md">
                 <div className="flex items-center gap-3">
                    <div className="bg-gray-800 p-2 rounded-full"><Headset size={20} className="text-[#D4AF37]"/></div>
                    <div>
                        <h3 className="font-bold text-sm">الدعم الفني الذكي</h3>
                        <p className="text-[10px] text-gray-400">متواجدون لمساعدتك في حال وجود مشكلة</p>
                    </div>
                 </div>
                 <button onClick={() => setShowSupportChat(false)} className="text-gray-400 hover:text-white transition-colors bg-gray-800 p-1.5 rounded-full"><X size={16} /></button>
              </div>

              {/* Chat Area */}
              <div className="flex-1 bg-[#F8F9FA] p-4 overflow-y-auto flex flex-col gap-3">
                 <div className="text-center my-2">
                    <span className="bg-blue-50 text-blue-700 text-[10px] font-bold px-3 py-1 rounded-full border border-blue-100">بادر بإرسال مشكلتك بوضوح أو اختر من أدناه</span>
                 </div>
                 {chatMessages.length === 0 && (
                   <div className="flex flex-col gap-2 mt-2 px-2">
                       <div className="bg-white p-3 rounded-2xl border border-blue-100 shadow-sm flex flex-col gap-2 mb-2">
                           <p className="text-[10px] text-blue-700 font-bold mb-1">بيانات تواصل الإدارة (أكملها قبل الإرسال):</p>
                           <input 
                              value={supportNameInput}
                              onChange={e => setSupportNameInput(e.target.value)}
                              placeholder="الاسم ثلاثي (إجباري)*"
                              className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-xs focus:border-[#D4AF37] outline-none"
                           />
                           <input 
                              value={supportBankInput}
                              onChange={e => setSupportBankInput(e.target.value)}
                              placeholder="البنك الذي تحاول الدخول إليه (اختياري)"
                              className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-xs focus:border-[#D4AF37] outline-none"
                           />
                       </div>
                      <button type="button" onClick={(e) => handleSendSupportMessage(e, "مشكلة في التسجيل أو الدخول")} className="bg-white border border-gray-200 p-3 rounded-xl text-xs font-bold text-gray-700 hover:border-[#D4AF37] hover:text-[#D4AF37] text-right transition-colors shadow-sm">مشكلة في التسجيل أو الدخول</button>
                      <button type="button" onClick={(e) => handleSendSupportMessage(e, "مشكلة في بنوك الأسئلة")} className="bg-white border border-gray-200 p-3 rounded-xl text-xs font-bold text-gray-700 hover:border-[#D4AF37] hover:text-[#D4AF37] text-right transition-colors shadow-sm">مشكلة في بنوك الأسئلة</button>
                      <button type="button" onClick={(e) => handleSendSupportMessage(e, "مشكلة أخرى")} className="bg-white border border-gray-200 p-3 rounded-xl text-xs font-bold text-gray-700 hover:border-[#D4AF37] hover:text-[#D4AF37] text-right transition-colors shadow-sm">مشكلة أخرى</button>
                   </div>
                 )}
                 {chatMessages.map(msg => {
                    let text = msg.message;
                    let options: string[] = [];
                    const optionsMatch = text.match(/\[خيارات:\s*(.*?)\]/);
                    if (optionsMatch) {
                       options = optionsMatch[1].split('|').map((o: string) => o.trim());
                       text = text.replace(optionsMatch[0], '');
                    }
                    return (
                      <div key={msg.id} className={`flex flex-col gap-1 ${msg.sender === 'student' ? 'items-end' : 'items-start'}`}>
                         <div className={`max-w-[80%] p-3 rounded-2xl text-sm ${msg.sender === 'student' ? 'bg-[#D4AF37] text-white rounded-br-sm shadow-md' : 'bg-white border border-gray-200 text-gray-800 rounded-bl-sm shadow-sm leading-relaxed'}`}>
                             <ReactMarkdown>{text.trim()}</ReactMarkdown>
                         </div>
                         {options.length > 0 && msg.id === chatMessages[chatMessages.length - 1].id && (
                            <div className="flex flex-col gap-2 mt-2 w-full max-w-[80%]">
                                {options.map((opt, idx) => (
                                   <button key={idx} type="button" onClick={(e) => handleSendSupportMessage(e, opt)} className="bg-white border border-gray-200 p-2.5 rounded-xl text-xs font-bold text-gray-700 hover:border-[#D4AF37] hover:text-[#D4AF37] text-right transition-colors shadow-sm flex items-center justify-between">
                                      <span>{opt}</span>
                                   </button>
                                ))}
                            </div>
                         )}
                      </div>
                    );
                 })}
              </div>

              {/* Input Area */}
              <div className="p-3 bg-white border-t border-gray-100">
                 <form onSubmit={handleSendSupportMessage} className="flex gap-2">
                    <input 
                       value={supportMessage}
                       onChange={e => setSupportMessage(e.target.value)}
                       placeholder="اكتب رسالتك للإدارة هنا..."
                       className="flex-1 bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:border-[#D4AF37] outline-none"
                    />
                    <button type="submit" disabled={!supportMessage.trim()} className="bg-[#1A1A1A] hover:bg-black text-white w-12 flex items-center justify-center rounded-xl transition-colors disabled:opacity-50"><Send size={18} /></button>
                 </form>
              </div>
           </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
