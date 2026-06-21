import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useNavigate } from 'react-router-dom';
import { Bookmark, AlertTriangle, Moon, Sun, X, Send, Copy, Maximize2, FolderOpen, Settings, ChevronRight, ChevronLeft, LogOut, Bot, LayoutList, Trash, Paperclip, MessageCircle, ShieldAlert, Headset, RefreshCw, EyeOff, BookX, Check, Download, CloudOff, Share2 } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import ReactMarkdown from 'react-markdown';
import localforage from 'localforage';
import { db, handleFirestoreError, OperationType } from '@/src/lib/firebase';
import { doc, getDoc, setDoc, addDoc, increment, collection, serverTimestamp, getDocs, query, where, orderBy, onSnapshot, updateDoc } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { generateContentWithRetry } from '@/src/lib/gemini';

import toast from 'react-hot-toast';

const BAD_WORDS = ["شتيمة", "حمار", "كلب", "غبي", "stupid", "idiot", "shit", "fuck", "bitch"];

export default function Exam() {
  const navigate = useNavigate();
  const { studentData, loginAdmin, loginStudent, logout } = useAuth();
  const [questions, setQuestions] = useState<any[]>([]);
  const [banks, setBanks] = useState<any[]>([]);
  const [selectedBankId, setSelectedBankId] = useState<string | null>(null);
  const [loadingBanks, setLoadingBanks] = useState(true);
  const [loadingQuestions, setLoadingQuestions] = useState(false);
  
  const [examMode, setExamMode] = useState<'immediate' | 'deferred'>('immediate');
  const [showModeSelect, setShowModeSelect] = useState<string | null>(null);

  const [downloadingBankId, setDownloadingBankId] = useState<string | null>(null);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, number>>({});
  const [essayAnswers, setEssayAnswers] = useState<Record<string, string>>({});
  const [essayChecked, setEssayChecked] = useState<Record<string, {isCorrect: boolean, feedback: string}>>({});
  const [bookmarked, setBookmarked] = useState<Record<string, boolean>>({});
  const [crossedOutOptions, setCrossedOutOptions] = useState<Record<string, number[]>>({});
  const [studentId, setStudentId] = useState<string>('');
  const [downloadedBanks, setDownloadedBanks] = useState<string[]>([]);

  useEffect(() => {
     localforage.keys().then(keys => setDownloadedBanks(keys.filter(k => k.startsWith('bank_')).map(k => k.replace('bank_', ''))));
  }, []);

  useEffect(() => {
    const checkOfflineAction = () => {
       if (!navigator.onLine && downloadedBanks.length > 0) {
           toast('يرجى العلم: أنت تعمل الآن في وضع "بدون إنترنت". تم توفير البنوك التي قمت بتحميلها للعمل بشكل مستمر. (تأكد من تثبيت التطبيق على الشاشة الرئيسية للحصول على أفضل أداء).', {
             icon: '📱',
             duration: 6000
           });
       }
    };
    window.addEventListener('offline', checkOfflineAction);
    if (!navigator.onLine) checkOfflineAction();
    return () => window.removeEventListener('offline', checkOfflineAction);
  }, [downloadedBanks]);

  const downloadBankOffline = async (e: React.MouseEvent, bankId: string) => {
     e.stopPropagation();
     try {
         alert('جاري تحميل الأسئلة للعمل بدون إنترنت...');
         const qSnap = await getDocs(query(collection(db, 'live_banks'), where('bankId', '==', bankId)));
         const fetchedQs = qSnap.docs.map(d => ({ id: d.id, ...d.data() }));
         await localforage.setItem('bank_' + bankId, fetchedQs);
         setDownloadedBanks(prev => [...prev, bankId]);
         alert('تم تحميل البنك بنجاح! يمكنك الآن الدخول وتأدية الاختبار بدون إنترنت.');
     } catch (err) {
         console.error(err);
         alert('حدث خطأ أثناء تحميل البنك.');
     }
  };

  const syncResultsOffline = async () => {
       try {
           const cachedResults: any[] = await localforage.getItem('sync_queue') || [];
           if (cachedResults.length > 0 && navigator.onLine) {
               for (const res of cachedResults) {
                   await addDoc(collection(db, 'exam_results'), res);
               }
               await localforage.removeItem('sync_queue');
               // تمت مزامنة النتائج المحفوظة محلياً
           }
       } catch (err) {
           console.error('فشل المزامنة', err);
       }
  };
  
  // Try sync on load if online
  useEffect(() => {
      window.addEventListener('online', syncResultsOffline);
      return () => window.removeEventListener('online', syncResultsOffline);
  }, []);
  
  // Post-Exam State
  const [isFinished, setIsFinished] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);
  const [startTime, setStartTime] = useState(Date.now());
  const [timeTaken, setTimeTaken] = useState(0);
  const [studyGuide, setStudyGuide] = useState<string | null>(null);
  const [generatingGuide, setGeneratingGuide] = useState(false);
  const [rating, setRating] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);

  useEffect(() => {
    if (questions.length > 0 && !isFinished && timeRemaining !== null && timeRemaining > 0) {
      const timer = setInterval(() => {
        setTimeRemaining(prev => {
          if (prev && prev <= 1) {
            clearInterval(timer);
            setIsFinished(true);
            setTimeTaken(Math.round((Date.now() - startTime) / 60000));
            return 0;
          }
          return prev ? prev - 1 : 0;
        });
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [questions.length, isFinished, timeRemaining]);

  // AI Chat State
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<{role: string, content: string, hasAttachment?: boolean}[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [chatFile, setChatFile] = useState<{file: File, base64: string, mimeType: string} | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const lastChatTimeRef = useRef(0);

  // Support Chat State
  const [showSupportChat, setShowSupportChat] = useState(false);
  const [supportMessage, setSupportMessage] = useState('');
  const [supportChatMessages, setSupportChatMessages] = useState<any[]>([]);
  const supportChatEndRef = useRef<HTMLDivElement>(null);

  // Lightbox State
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  const [isBannedState, setIsBannedState] = useState(false);

  // Settings State
  const [showSettings, setShowSettings] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportReason, setReportReason] = useState('');
  const [themeMode, setThemeMode] = useState<'light'|'sepia'|'dark'>('light');
  const [brightness, setBrightness] = useState(100);
  const [displayName, setDisplayName] = useState(studentData?.name || '');

  useEffect(() => {
    if (themeMode === 'dark') {
       document.documentElement.classList.add('dark-mode');
    } else {
       document.documentElement.classList.remove('dark-mode');
    }
  }, [themeMode]);

  // Admin Upgrade State
  const [showAdminUpgrade, setShowAdminUpgrade] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');

  const [globalSettings, setGlobalSettings] = useState<any>(null);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'admin_system', 'global_settings'), (snap) => {
        if (snap.exists()) {
            setGlobalSettings(snap.data());
        }
    });
    return () => unsub();
  }, []);

  const handleAdminUpgrade = () => {
    if (adminPassword === "nursing admins 123") {
      let name = "Admin Student";
      if (studentData) {
        name = studentData.name;
      }
      loginAdmin(name);
      navigate('/admin-dashboard', { replace: true });
    } else {
      alert("كلمة المرور غير صحيحة");
    }
  };

  useEffect(() => {
    if(!studentData || !studentData.id) return;
    const updatePresence = async () => {
      try {
        const { doc, setDoc, serverTimestamp } = await import('firebase/firestore');
        await setDoc(doc(db, 'users', studentData.id), {
           lastActive: serverTimestamp(),
           isOnline: true,
           fullName: studentData.fullName || studentData.name || 'طالب مجهول'
        }, { merge: true });
      } catch(e) {}
    };
    updatePresence();
    const interval = setInterval(updatePresence, 3 * 60 * 1000); // 3 minutes
    return () => clearInterval(interval);
  }, [studentData]);

  useEffect(() => {
    let unsubUser = () => {};
    let unsubGlobal = () => {};
    let unsubStrikes = () => {};
    // Check Auth
    if (!studentData) {
      if (!window.location.search.includes('public')) {
        navigate('/login', { replace: true });
        return;
      }
    } else {
      setStudentId(studentData.id);
      
      // PERSISTENT ACCESS CHECK: Ensure student account is still in allowed_students collection and verify device binding
      const isBypassed = studentData.id.startsWith('dummy_');
      
      // Realtime listener on global_settings alert (Handled in App.tsx now)

      if (!isBypassed && !studentData.id.startsWith('student_')) {
          try {
             // 1. One time check on allowed_students
             const verifyAccess = async () => {
                 const allowedSnap = await getDoc(doc(db, 'allowed_students', studentData.id));
                 if (allowedSnap.exists()) {
                    const data = allowedSnap.data();
                    if (data.expiresAt) {
                        const expTime = data.expiresAt.toDate ? data.expiresAt.toDate().getTime() : data.expiresAt;
                        if (expTime < Date.now()) {
                            logout();
                            navigate('/login', { replace: true });
                            alert("تنبيــه: انتهت صلاحية حسابك.");
                            return;
                        }
                    }
                 } else {
                    logout();
                    navigate('/login', { replace: true });
                    alert("تنبيــه: تم إلغاء صلاحية هذا الاسم أو حذفه من قبل الإدارة.");
                    return;
                 }
             };
             verifyAccess();

             // 1.5 Realtime listener on Strikes for Instant Ban
             unsubStrikes = onSnapshot(doc(db, 'strikes', studentData.id), (docSnap: any) => {
                 if (docSnap.exists() && docSnap.data().banned) {
                     setIsBannedState(true);
                 } else {
                     setIsBannedState(false);
                 }
             });

             // 2. Realtime listener on Users collection for device override
             unsubUser = onSnapshot(doc(db, 'users', studentData.id), (docSnap: any) => {
                 if (docSnap.exists()) {
                     const data = docSnap.data();
                     // Check device mismatch
                     const localDeviceId = localStorage.getItem('tamrediano_device_id');
                     if (data.currentDeviceId && localDeviceId && data.currentDeviceId !== localDeviceId) {
                         logout();
                         navigate('/login', { replace: true });
                         alert("تم تسجيل الدخول من جهاز آخر. تم تسجيل الخروج من هذا الحساب.");
                         return;
                     }
                 }
             });
          } catch(e) {
             console.error("Access verification error:", e);
          }
      }
    }

    let unsubBanks = () => {};
    let initialLoad = true;
    
    // Fallback localforage cache lookup before snapshot completes
    localforage.getItem('cached_banks_list').then((cached: any) => {
        if (cached && cached.length > 0 && initialLoad) {
            setBanks(cached);
            setLoadingBanks(false);
        }
    }).catch(e => console.error(e));

    // Fallback timer just in case Firestore hangs
    const fallbackTimer = setTimeout(() => {
        if (initialLoad) setLoadingBanks(false);
    }, 5000);

    unsubBanks = onSnapshot(collection(db, 'banks'), (banksSnap) => {
      const now = Date.now();
      const fetchedBanks = banksSnap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter((b: any) => (!b.autoDeleteAt || b.autoDeleteAt > now) && b.isPublished !== false);
      
      setBanks(fetchedBanks);
      localforage.setItem('cached_banks_list', fetchedBanks);
      clearTimeout(fallbackTimer);
      setLoadingBanks(false);

      if (initialLoad) {
          initialLoad = false;
          const savedState = localStorage.getItem('tamrediano_exam_state');
          const urlParams = new URLSearchParams(window.location.search);
          const bankIdUrl = urlParams.get('bank');
          const mistakesUrl = urlParams.get('mistakes');

          if (mistakesUrl) {
              getDoc(doc(db, 'shared_mistakes', mistakesUrl)).then(snap => {
                  if (snap.exists()) {
                      const data = snap.data();
                      setQuestions(data.questions || []);
                      setExamMode('immediate');
                      setSelectedAnswers({});
                      setEssayAnswers({});
                      setEssayChecked({});
                      setBookmarked({});
                      setCurrentIndex(0);
                      setIsFinished(false);
                      setStartTime(Date.now());
                      // Make it behave like a bank
                      setSelectedBankId('shared_mistakes_bank');
                  } else {
                      alert('بنك الأخطاء المشترك غير موجود أو منتهي الصلاحية.');
                  }
              });
          } else if (savedState) {
              const parsed = JSON.parse(savedState);
              // Check if restored bank still exists!
              const bankExists = fetchedBanks.find(b => b.id === parsed.bankId) as any;
              let isAllowed = false;
              if (bankExists) {
                  if (bankExists.isPublic !== false) {
                      isAllowed = true;
                  } else if (bankExists.allowedNames) {
                      const normalize = (n: string) => n.trim().replace(/\s+/g, ' ');
                      const authName = normalize(studentData?.fullName || studentData?.name || '');
                      const names = bankExists.allowedNames.split('\n').map(normalize).filter((n: string) => n);
                      isAllowed = names.includes(authName);
                  }
              }

              // If URL bank exists and is different from saved state bank, ignore saved state
              if (bankIdUrl && bankIdUrl !== parsed.bankId && fetchedBanks.find(b => b.id === bankIdUrl)) {
                  localStorage.removeItem('tamrediano_exam_state');
                  localStorage.removeItem('tamrediano_exam_time');
                  setShowModeSelect(bankIdUrl);
              } 
              else if (isAllowed && bankExists && parsed.bankId && parsed.questions && parsed.questions.length > 0) {
                  if (parsed.isFinished) {
                      localStorage.removeItem('tamrediano_exam_state');
                      localStorage.removeItem('tamrediano_exam_time');
                      if (bankIdUrl) setShowModeSelect(bankIdUrl);
                  } else if (bankIdUrl === parsed.bankId) {
                      // Only auto-resume if the URL specifically matches the saved bank id
                      setSelectedBankId(parsed.bankId);
                      setQuestions(parsed.questions);
                      setSelectedAnswers(parsed.selectedAnswers || {});
                      setEssayAnswers(parsed.essayAnswers || {});
                      setEssayChecked(parsed.essayChecked || {});
                      setBookmarked(parsed.bookmarked || {});
                      setCurrentIndex(parsed.currentIndex || 0);
                      const savedTime = localStorage.getItem('tamrediano_exam_time');
                      if (savedTime && !isNaN(parseInt(savedTime))) {
                          setTimeRemaining(parseInt(savedTime));
                      } else {
                          setTimeRemaining(parsed.timeRemaining ?? null);
                      }
                      if (parsed.examMode) setExamMode(parsed.examMode);
                  } else {
                      if (bankIdUrl) setShowModeSelect(bankIdUrl);
                  }
              } else {
                  // Clear invalid state
                  localStorage.removeItem('tamrediano_exam_state');
                  localStorage.removeItem('tamrediano_exam_time');
                  if (bankIdUrl && fetchedBanks.find(b => b.id === bankIdUrl)) {
                      setShowModeSelect(bankIdUrl);
                  }
              }
          } else {
              if (bankIdUrl && fetchedBanks.find(b => b.id === bankIdUrl)) {
                  setShowModeSelect(bankIdUrl);
              }
          }
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, 'banks');
      clearTimeout(fallbackTimer);
      setLoadingBanks(false);
    });

    return () => {
        unsubUser();
        unsubGlobal();
        unsubStrikes();
        unsubBanks();
    };
  }, [navigate]);

  useEffect(() => {
    if (questions.length > 0 && selectedBankId !== null) { // !== null check
      localStorage.setItem('tamrediano_exam_state', JSON.stringify({
        bankId: selectedBankId,
        questions,
        selectedAnswers,
        essayAnswers,
        essayChecked,
        bookmarked,
        currentIndex,
        examMode,
        isFinished
      }));
    }
  }, [questions, selectedAnswers, essayAnswers, essayChecked, bookmarked, currentIndex, selectedBankId, examMode, isFinished]);
  
  useEffect(() => {
     if (questions.length > 0 && selectedBankId !== null && timeRemaining !== null) {
         localStorage.setItem('tamrediano_exam_time', timeRemaining.toString());
     }
  }, [timeRemaining, selectedBankId, questions.length]);
  
  useEffect(() => {
    if (supportChatEndRef.current) {
        supportChatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [supportChatMessages]);

  useEffect(() => {
     const deviceId = studentData?.id || localStorage.getItem('deviceId');
     if (!deviceId || !showSupportChat) return;
     const q = query(
         collection(db, 'support_chats'),
         where('deviceId', '==', deviceId),
         orderBy('createdAt', 'asc')
     );
     const unsubscribe = onSnapshot(q, (snapshot) => {
         const msgs: any[] = [];
         snapshot.forEach(doc => msgs.push({ id: doc.id, ...doc.data() }));
         setSupportChatMessages(msgs);
     });
     return () => unsubscribe();
  }, [showSupportChat, studentData?.id]);

  const [isSupportChatLoading, setIsSupportChatLoading] = useState(false);

  const handleSendSupportMessage = async (e?: React.FormEvent, directMessage?: string) => {
      e?.preventDefault();
      const msg = directMessage || supportMessage;
      if (!msg.trim()) return;
      
      if (!directMessage) setSupportMessage('');
      
      const lowerMsg = msg.toLowerCase();
      if (['شتيمة', 'حمار', 'كلب', 'غبي', 'stupid', 'idiot', 'shit', 'fuck', 'bitch', 'خرا', 'زفت'].some(w => lowerMsg.includes(w))) {
          toast.error("تنبيه شديد اللهجة: يرجى احترام قواعد المحادثة وتجنب الألفاظ السيئة. الإدارة تراقب المحادثات.");
      }
      
      const currentBank = banks.find(b => b.id === selectedBankId);
      const deviceId = studentData?.id || localStorage.getItem('deviceId') || 'unknown';
      
      try {
          await addDoc(collection(db, 'support_chats'), {
              deviceId,
              studentName: studentData?.fullName || studentData?.name || 'طالب مجهول',
              message: msg,
              sender: 'student',
              createdAt: serverTimestamp(),
              bankName: currentBank?.name || ''
          });

          const hasRealAdminReplied = supportChatMessages.some(m => m.sender === 'admin' && m.studentName !== 'الدعم الفني الذكي');
          
          if (hasRealAdminReplied) return;

          // AI Response
          setIsSupportChatLoading(true);
          try {
              let aiContextInfo = "";
              try {
                  const allowedSnap = await getDocs(collection(db, 'allowed_students'));
                  const allowedNames = allowedSnap.docs.map(d => d.data().fullName || d.data().name);
                  
                  const usersSnapList = await getDocs(collection(db, 'users'));
                  const currentUsers = usersSnapList.docs.map(d => d.data().fullName || d.data().name);

                  const allValidNames = Array.from(new Set([...allowedNames, ...currentUsers]));
                  
                  const banksSnap = await getDocs(collection(db, 'banks'));
                  const bankNames = banksSnap.docs.map(d => d.data().name);

                  const currentActionContext = `الطالب الآن يحل في البنك رقم ${selectedBankId || 'لا يوجد'}. السؤال الحالي المفتوح: ${questions[currentIndex]?.text || 'لا يوجد'}. عدد الاسئلة المحلولة: ${Object.keys(selectedAnswers).length}`;
                  aiContextInfo = `\nمعلومات هامة: الأسماء المسجلة بالمنصة: ${allValidNames.join("، ")} | البنوك المتاحة: ${bankNames.join("، ")}\n(اسم الطالب الحالي: ${studentData?.fullName || studentData?.name || 'طالب مجهول'})\n(سياق النشاط: ${currentActionContext})`;
              } catch(e) {}

              const systemInstruction = `أنت موظف دعم فني حقيقي لمنصة "تمريضيانو"، وهي منصة تعليمية لطلاب التمريض تقدم امتحانات وتدريبات.
تحدث بلهجة مصرية محترمة جداً، تفاعل بمرح وخفة ظل وهزار خفيف ولكن في محله فقط بدون تجاوز. احترم جداً هيئة التدريس والكلية وإياك أن تتحدث عن أمور مالية. تحدث مع الطالب كذكراً إذا كان اسمه يوحي بذلك، وتحدثي معها كأنثى إذا كان اسمها يوحي بذلك، ولا تخطئ في هذا.
أنت تتحدث مع: ${studentData?.fullName || studentData?.name || 'طالب مجهول'}.
خطتك:
1- اقرأ تاريخ المحادثة ولا تكرر الكلام العادي.
2- ممنوع منعاً باتاً تحت أي ظرف طلب كلمة السر أو الباسوورد. لا تطلب منه أي بيانات لا تخصه. وممنوع إعطاء أي طالب بيانات شخص آخر تحت أي ظرف.
3- عندما تطلب منه كتابة أي شيء، إياك أن تكتب [خيارات: ...] أبداً في هذه الرسالة، اتركه يكتب رده.
4- إذا لم تكن تطلب منه كتابة شيء، بل تريد توجيهه، اطرح عليه خيارات ليضغط عليها، واكتبها في نهاية الرد بالشكل ده: [خيارات: مشكلة في البنك | مشكلة تقنية | حاجة تانية]. هام جداً: ممنوع دمج طلب كتابة والخيارات في رسالة واحدة.
5- لو بيسأل عن المشكلة التقنية حاول تحلها في أسرع وقت.
6- لو شتم: اديله تحذير شديد أول مرة، لو كررها قوله سيتم حظرك واكتب: [حظر: اسمه بالكامل].
7- لفك الحظر، اكتب: [فك حظر: اسمه بالكامل].
8- تعديل سؤال: لو في سؤال غلط والطالب معاه مصدر يثبت، وراجعت المصدر وتأكدت تماماً. اكتب: [تعديل سؤال: هو الـ id الخاص للسؤال كذا] [الإجابة كذا]. إياك أن تطلب منه إثبات لو أنت متأكد من المصدر المرفق. يمكنك استخدام هذه الميزة لكتابة الآتي بالضبط في رسالتك: [تعديل سؤال: <ضع q.id هنا>] [الإجابة الجديدة: <رقم الخيار الصحيح 0,1,2,3>].
9- تعطيل بنك: إذا لقيت البنك بايظ فعلاً تأكد من اسمه في البنوك وعطلة فوراً: [تعطيل بنك: اسم البنك].
10- الوعي بالسياق: ${aiContextInfo}`;

              const history = supportChatMessages.map(m => `[${m.sender === 'student' ? 'الطالب' : 'الدعم'}]: ${m.message}`).join('\n');
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

              const disableBankMatch = replyText.match(/\[تعطيل بنك:\s*(.*?)\]/);
              if (disableBankMatch && disableBankMatch[1]) {
                  const bName = disableBankMatch[1].trim();
                  try {
                      const banksSnap = await getDocs(collection(db, 'banks'));
                      const bDoc = banksSnap.docs.find(d => d.data().name === bName);
                      if (bDoc) {
                          await updateDoc(doc(db, 'banks', bDoc.id), { isPublished: false });
                      }
                  } catch(e) {}
                  replyText = replyText.replace(disableBankMatch[0], '');
              }

              const editMatch = replyText.match(/\[تعديل سؤال:\s*(.*?)\]\s*\[الإجابة الجديدة:\s*(.*?)\]/);
              if (editMatch && editMatch[1]) {
                  const qIdToEdit = editMatch[1].trim();
                  const newAns = parseInt(editMatch[2].trim());
                  try {
                      if (!isNaN(newAns)) {
                         await updateDoc(doc(db, 'live_banks', qIdToEdit), { correct: newAns });
                      }
                  } catch(e) {}
                  replyText = replyText.replace(editMatch[0], '');
              }

              if (replyText) {
                  await addDoc(collection(db, 'support_chats'), {
                      deviceId,
                      studentName: 'الدعم الفني الذكي',
                      message: replyText,
                      sender: 'admin',
                      createdAt: serverTimestamp(),
                      bankName: currentBank?.name || ''
                  });
              }
          } catch (err: any) {
              console.error("AI support chat failed", err.message || err);
              // Fallback message for the user if AI hits quota limit or fails completely
              await addDoc(collection(db, 'support_chats'), {
                  deviceId,
                  studentName: 'النظام',
                  message: (err.message && err.message.includes('quota')) 
                           ? "نأسف، هناك ضغط كبير على النظام حالياً. لقد تم تحويل رسالتك للمشرف وسيقوم بالرد عليك في أقرب وقت هنا." 
                           : "عذراً، حدث خطأ تقني في الدعم الفني الذكي. لقد تم تحويل مشكلتك للمشرف.",
                  sender: 'admin',
                  createdAt: serverTimestamp(),
                  bankName: currentBank?.name || ''
              });
          } finally {
              setIsSupportChatLoading(false);
          }
      } catch (err: any) {
          console.error(err.message || err);
      }
  };

  useEffect(() => {
    if (chatEndRef.current) {
        chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages]);

  const loadQuestionsForBank = async (bankId: string) => {
    setShowModeSelect(null);
    setSelectedBankId(bankId);
    setQuestions([]);
    setLoadingQuestions(true);
    
    // Fallback timer to prevent infinite loading if getDocs blocks
    const qsFallbackTimer = setTimeout(() => {
        if (loadingQuestions) {
            alert('انتهى التوقيت المخصص لجلب الأسئلة. الرجاء التحقق من اتصالك بالإنترنت والمحاولة مجدداً.');
            setSelectedBankId(null);
            setLoadingQuestions(false);
        }
    }, 8000);

    try {
        const bankData = banks.find(b => b.id === bankId);
        if (bankData?.timeLimit && bankData.timeLimit > 0) {
            setTimeRemaining(bankData.timeLimit * 60);
        } else {
            setTimeRemaining(null);
        }

        let fetchedQs: any[] = [];
        try {
            if (navigator.onLine) {
                const qSnap = await getDocs(query(collection(db, 'live_banks'), where('bankId', '==', bankId)));
                fetchedQs = qSnap.docs.map(d => ({ id: d.id, ...d.data() }));
            } else {
                fetchedQs = (await localforage.getItem('bank_' + bankId)) || [];
                if (fetchedQs.length === 0) throw new Error('offline_no_cache');
            }
        } catch (err: any) {
            fetchedQs = (await localforage.getItem('bank_' + bankId)) || [];
            if (fetchedQs.length === 0) {
                alert('لا يوجد اتصال بالإنترنت وهذا البنك غير محمل مسبقاً.');
                setSelectedBankId(null);
                setLoadingQuestions(false);
                clearTimeout(qsFallbackTimer);
                return;
            }
        }
        
        clearTimeout(qsFallbackTimer);
        
        if (fetchedQs.length === 0) {
            alert('لا توجد أسئلة متاحة في هذا البنك حالياً.');
            setSelectedBankId(null);
            setLoadingQuestions(false);
            return;
        }

        // Shuffle choices for each question
        const preparedQuestions = fetchedQs.map((q: any) => {
          const choices = q.options.map((opt: string, i: number) => ({ text: opt, originalIndex: i }));
          return {
            ...q,
            choices: choices
          };
        });
        
        setQuestions(preparedQuestions);
        setStartTime(Date.now());
        setLoadingQuestions(false);
        
        localStorage.setItem('tamrediano_exam_state', JSON.stringify({
          bankId: bankId,
          questions: preparedQuestions,
          selectedAnswers: {},
          essayAnswers: {},
          essayChecked: {},
          bookmarked: {},
          currentIndex: 0,
          examMode: examMode
        }));
    } catch (err) {
        handleFirestoreError(err, OperationType.GET, 'live_banks');
        setSelectedBankId(null);
        setLoadingQuestions(false);
    }
  };

  const quitExam = () => {
      localStorage.removeItem('tamrediano_exam_state');
      localStorage.removeItem('tamrediano_exam_time');
      setQuestions([]);
      setSelectedBankId(null);
      setSelectedAnswers({});
      setEssayAnswers({});
      setEssayChecked({});
      setBookmarked({});
      setCurrentIndex(0);
      setIsFinished(false);
  };

  const handleCheckEssay = async (questionId: string) => {
      const q = questions.find(q => q.id === questionId);
      const ans = essayAnswers[questionId];
      if (!q || !ans?.trim()) return;
      
      setEssayChecked(prev => ({ ...prev, [questionId]: { isCorrect: false, feedback: 'جاري التقييم...' } }));
      
      try {
          const response = await generateContentWithRetry('chat', {
             model: 'gemini-1.5-flash',
             contents: [{
                role: 'user',
                parts: [{ text: `Evaluate this student's answer to the essay question.
Question: ${q.text}
Model Answer (Explanation): ${q.explanation}
Student Answer: ${ans}

Instructions: Be very lenient. If the student captures the main point, even briefly or with easier words, mark it correct. Return a JSON object:
{ "isCorrect": true/false, "feedback": "Brief feedback in friendly Egyptian Arabic, addressing the student." }` }]
             }],
             config: { responseMimeType: "application/json" }
          });
          let res;
          try {
              res = JSON.parse(response.text);
          } catch(e) {
              const match = response.text.match(/```(?:json)?\n?([\s\S]*?)```/);
              if (match) res = JSON.parse(match[1]);
              else throw e;
          }
          setEssayChecked(prev => ({ ...prev, [questionId]: { isCorrect: res.isCorrect, feedback: res.feedback } }));
          // Mark as answered
          setSelectedAnswers(prev => ({ ...prev, [questionId]: 0 })); 
      } catch (e) {
          setEssayChecked(prev => ({ ...prev, [questionId]: { isCorrect: false, feedback: 'حدث خطأ أثناء التقييم.' } }));
      }
  };

  const handleSelectAnswer = (questionId: string, choiceOriginalIndex: number) => {
    if (selectedAnswers[questionId] !== undefined) return; // Already answered
    
    // Check mistake and save locally
    const q = questions.find(q => q.id === questionId);
    if (q && choiceOriginalIndex !== q.correct) {
       if (studentData?.fullName || studentData?.name) {
           const studentName = studentData.fullName || studentData.name;
           const key = `tamrediano_mistakes_${studentName}`;
           try {
              const current = JSON.parse(localStorage.getItem(key) || '[]');
              if (!current.find((m: any) => m.id === questionId)) {
                  const qToSave = { ...q, sourceBankId: selectedBankId, sourceBankName: banks.find(b => b.id === selectedBankId)?.name || 'غير معروف' };
                  current.push(qToSave);
                  localStorage.setItem(key, JSON.stringify(current));
              }
           } catch(e) {}
       }
    }
    
    setSelectedAnswers(prev => ({ ...prev, [questionId]: choiceOriginalIndex }));
  };

  const toggleBookmark = (questionId: string) => {
    setBookmarked(prev => ({ ...prev, [questionId]: !prev[questionId] }));
  };

  const checkAndRecordStrike = async (text: string) => {
      const lower = text.toLowerCase();
      const hasBad = BAD_WORDS.some(w => lower.includes(w));
      if (hasBad && studentId) {
         try {
            const strikeRef = doc(db, 'strikes', studentId);
            const strikeSnap = await getDoc(strikeRef);
            if (strikeSnap.exists()) {
                const data = strikeSnap.data();
                if (data.count >= 2) {
                    await setDoc(strikeRef, { count: increment(1), banned: true }, { merge: true });
                } else {
                    await setDoc(strikeRef, { count: increment(1) }, { merge: true });
                }
            } else {
                await setDoc(strikeRef, { count: 1, banned: false });
            }
         } catch (e) {
             console.error("Strike update failed", e);
         }
         return true;
      }
      return false;
  };

  const handleReportLeaders = async () => {
     const q = questions[currentIndex];
     const initialMsg = `[إبلاغ عن سؤال]:\n${q.text}\n---\nالمشكلة: `;
     setSupportMessage(initialMsg);
     setShowSupportChat(true);
  };

  // AI Chat Logic
  const handleChatSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() && !chatFile) return;

    const userMessage = chatInput;
    const currentAttachment = chatFile;
    setChatInput('');
    setChatFile(null);
    
    // Check auto-ban
    if (userMessage) {
       const hasStriked = await checkAndRecordStrike(userMessage);
       if (hasStriked) {
           setChatMessages(prev => [...prev, { role: 'user', content: userMessage }, { role: 'model', content: 'نظام الرقابة الآلي: تم تسجيل إنذار ضد حسابك لاستخدام ألفاظ غير مقبولة.' }]);
           return;
       }
    }

    setChatMessages(prev => [...prev, { role: 'user', content: userMessage || 'تم إرفاق ملف.', hasAttachment: !!currentAttachment }]);
    setIsChatLoading(true);

    try {
      let contextQs: any[] = [];
      if (isFinished) {
          contextQs = questions.map((q, i) => {
             const userVisibleChoices = (q.choices || q.options.map((opt: string, idx: number) => ({ text: opt, originalIndex: idx })))
                .map((c: any, index: number) => `${String.fromCharCode(65 + index)}: ${c.text}`);
             return {
                 index: i + 1,
                 questionText: q.text,
                 choices: userVisibleChoices,
                 correctAnswer: q.options[q.correct],
                 studentSelectedAnswer: selectedAnswers[q.id] !== undefined ? q.options[selectedAnswers[q.id]] : "لم يُجب"
             };
          });
      } else {
          const q = questions[currentIndex];
          const studentSelected = selectedAnswers[q.id] !== undefined ? q.options[selectedAnswers[q.id]] : "لم يختر الطالب إجابة بعد";
          const userVisibleChoices = (q.choices || q.options.map((opt: string, idx: number) => ({ text: opt, originalIndex: idx })))
             .map((c: any, index: number) => `${String.fromCharCode(65 + index)}: ${c.text}`);
          contextQs = [{ 
            index: currentIndex + 1,
            questionText: q.text, 
            choices: userVisibleChoices,
            correctAnswer: q.options[q.correct],
            studentSelectedAnswer: studentSelected
          }];
      }
        
      let referenceBook = "";
      if (selectedBankId) {
        try {
          const bankDoc = await getDoc(doc(db, "banks", selectedBankId));
          if (bankDoc.exists()) {
             referenceBook = bankDoc.data().referenceBook || "";
          }
        } catch (e) {
          console.error("Failed to fetch bank's reference book:", e);
        }
      }

      let systemInstruction = `You are a concise, accurate AI medical tutor for Tamrediano. 
Speak strictly in friendly Egyptian Arabic mixed with simple medical terminology in English. Your language must be VERY SIMPLE, clear, and easy to understand for nursing students. 
Avoid complex medical jargon where possible, and explain things using everyday analogies. Keep it EXTREMELY SHORT, DIRECT, and SUMMARIZED (ما قل ودل). DO NOT talk too much. Get straight to the point.

CRITICAL RULES FOR MULTIPLE CHOICE QUESTIONS (MCQs):
1. The student's screen shows the choices exactly as listed below.
2. The exact choices the student sees are provided below under "Choices". 
3. If the student asks "Why is the first option wrong?" or "Why is choice A wrong?", you MUST look at EXACTLY what is mapped to "A:" or the first item in the "Choices" list below. Strictly correlate their letter/position to the literal text provided below.

Never invent facts, numbers, or books. ONLY cite a book/page if it is explicitly provided in the question's explanation or reference text. Always mention the correct page number if it exists in the source text. If you don't know, say you don't know.`;

      if (referenceBook) {
        systemInstruction += `\n\nCRITICAL CONTEXT / SUBJECT BOOK REFERENCE (Please answer the student's question strictly according to this subject matter and medical information):\n${referenceBook}\n`;
      }

      if (contextQs && contextQs.length > 0) {
        systemInstruction += `\nHere are the questions the student is asking about:\n`;
        contextQs.forEach((q: any, i: number) => {
          systemInstruction += `${q.index ? q.index : i + 1}. Q: ${q.questionText}\nChoices: ${q.choices ? q.choices.join(', ') : 'N/A'}\nCorrect Answer: ${q.correctAnswer}\nStudent's Selected Answer: ${q.studentSelectedAnswer || 'None'}\n`;
        });
      }

      const formattedHistory = [
        { role: "user", parts: [{ text: systemInstruction }] },
        { role: "model", parts: [{ text: "أهلاً بيك يا دكتور! أنا هنا عشان أساعدك وأشرحلك أي سؤال. اتفضل!" }] },
        ...(chatMessages || []).map((msg: any) => ({
          role: msg.role === "user" ? "user" : "model",
          parts: [{ text: msg.content }]
        }))
      ];
      
      const userParts: any[] = [{ text: userMessage || 'Please refer to the attached document.' }];
      if (currentAttachment) {
          userParts.push({ inlineData: { data: currentAttachment.base64.split(',')[1] || currentAttachment.base64, mimeType: currentAttachment.mimeType } });
      }

      const response = await generateContentWithRetry('chat', {
        model: "gemini-2.5-flash",
        contents: [
            ...formattedHistory,
            { role: "user", parts: userParts }
        ]
      });

      setChatMessages(prev => [...prev, { role: 'model', content: response.text }]);
    } catch (err: any) {
      const errorMsg = (err.message && err.message.includes('quota')) 
                       ? 'عفواً، هناك ضغط كبير على النظام حالياً، يرجى المحاولة بعد قليل.' 
                       : 'عذراً، حدث خطأ في الاتصال بالذكاء الاصطناعي.';
      setChatMessages(prev => [...prev, { role: 'model', content: errorMsg }]);
    }
    setIsChatLoading(false);
  };

  const copyChat = () => {
    const text = chatMessages.map(m => `${m.role === 'user' ? 'أنت' : 'الذكاء الاصطناعي'}: ${m.content}`).join('\n\n');
    navigator.clipboard.writeText(text);
    alert('تم نسخ المحادثة!');
  };

  const finishExam = async () => {
    
    const end = Date.now();
    const durationMins = Math.round((end - startTime) / 60000);
    setTimeTaken(durationMins);
    setIsFinished(true);
    
    // Calculate Score
    let correctCount = 0;
    const incorrectQs: any[] = [];
    questions.forEach(q => {
       const userAns = selectedAnswers[q.id];
       if (q.type === 'essay' || (!q.choices?.length && !q.options?.length)) {
           if (essayChecked[q.id]?.isCorrect) {
               correctCount++;
           } else if (userAns !== undefined) {
               incorrectQs.push({
                   text: q.text,
                   explanation: q.explanation,
                   correctAnswer: "الإجابة النموذجية: " + q.explanation,
                   studentAnswer: essayAnswers[q.id]
               });
           }
       } else {
           if (userAns === q.correct) {
               correctCount++;
           } else if (userAns !== undefined) {
               incorrectQs.push({
                   text: q.text,
                   explanation: q.explanation,
                   correctAnswer: q.options ? q.options[q.correct] : ""
               });
           }
       }
    });

    const resultData = {
        studentId,
        studentName: studentData?.fullName || studentData?.name || 'غير معروف',
        score: correctCount,
        total: questions.length,
        timeTaken: durationMins,
        bankId: selectedBankId,
        bankName: banks.find(b => b.id === selectedBankId)?.name || 'غير معروف',
        createdAt: new Date(), // use JS date for offline compatibility
        incorrectIds: incorrectQs.map(iq => iq.text.substring(0, 50))
    };

    try {
        if (navigator.onLine) {
            await setDoc(doc(collection(db, 'exam_results')), { ...resultData, createdAt: serverTimestamp() });
        } else {
            const queue: any[] = (await localforage.getItem('sync_queue')) || [];
            queue.push(resultData);
            await localforage.setItem('sync_queue', queue);
            // Saved offline result
        }
    } catch (err) {
        console.error("Failed to save exam result", err);
    }
  };

  const handleGenerateStudyGuide = async () => {
      const incorrectStudyQs: any[] = [];
      questions.forEach(q => {
         const userAns = selectedAnswers[q.id];
         if (q.type === 'essay' || (!q.choices?.length && !q.options?.length)) {
             if (userAns !== undefined && !essayChecked[q.id]?.isCorrect) {
                 incorrectStudyQs.push({
                     text: q.text,
                     explanation: q.explanation,
                     correctAnswer: "الإجابة النموذجية: " + q.explanation
                 });
             }
         } else {
             if (userAns !== undefined && userAns !== q.correct) {
                 incorrectStudyQs.push({
                     text: q.text,
                     explanation: q.explanation,
                     correctAnswer: q.options ? q.options[q.correct] : ""
                 });
             }
         }
      });

      if (incorrectStudyQs.length === 0) {
          setStudyGuide("ممتاز! لقد أجبت على جميع الأسئلة بصورة صحيحة. استمر في هذا الأداء الرائع، ولا توجد أجزاء محددة تحتاج لمراجعتها في هذا الاختبار.");
          return;
      }

      setGeneratingGuide(true);
      try {
          let referenceBook = "";
          if (selectedBankId) {
            try {
              const bankDoc = await getDoc(doc(db, "banks", selectedBankId));
              if (bankDoc.exists()) {
                 referenceBook = bankDoc.data().referenceBook || "";
              }
            } catch (e) {
              console.error("Failed to fetch bank's reference book:", e);
            }
          }

          let systemInstruction = `أنت معلم ذكي لطلاب التمريض المصريين. 
الطالب أخطأ في هذه الأسئلة:
${incorrectStudyQs.map((q: any, i: number) => `سؤال: ${q.text}\nالصح: ${q.correctAnswer}\nشرح/تفسير: ${q.explanation}`).join('\n\n')}

المطلوب: قدم ملخصاً نقطياً (Bulleted list) دقيقاً جداً وبأسلوب "ما قل ودل". اشرح للطالب الأجزاء الدقيقة التي تحتاج مراجعة بناءً على الشروحات فقط.
تحدث بلهجة مصرية ودودة جداً تتخللها مصطلحات طبية إنجليزية بسيطة. لا تستخدم الجداول، ولا تزد في الكلام بلا داعي (No fluff).
هام جداً: استخرج أرقام الصفحات بدقة متناهية من نص الشرح/التفسير إذا كانت مكتوبة هناك. لو لم تُذكر صفحة صريحة، لا تخترع رقم صفحة أبداً.`;

          if (referenceBook) {
              systemInstruction += `\n\nالمصدر الذي تم سحب الأسئلة منه: "${referenceBook}". يمكنك الإشارة لاسمه لتوجيه الطالب، ولكن لا تؤلف أرقام صفحات منه إن لم توجد في الشرح.`;
          }

          const response = await generateContentWithRetry('chat', {
              model: "gemini-2.5-flash",
              contents: [{ role: "user", parts: [{ text: systemInstruction }] }]
          });
          setStudyGuide(response.text);
      } catch (e: any) {
          console.error(e.message || e);
          const errorMsg = (e.message && e.message.includes('quota')) 
                           ? 'عفواً، هناك ضغط كبير على النظام حالياً، يرجى المحاولة بعد قليل.' 
                           : 'فشل توليد التلخيص.';
          alert(errorMsg);
      }
      setGeneratingGuide(false);
  };

  const saveTaskList = () => {
      if (!studyGuide) return;
      const blob = new Blob([studyGuide], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "study-guide.txt";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
  };

  const handleSubmitFeedback = async () => {
      try {
          await setDoc(doc(collection(db, 'exam_feedback')), {
              studentId,
              studentName: displayName || studentData?.name || 'طالب مجهول',
              rating,
              feedback,
              bankId: selectedBankId,
              bankName: banks.find(b => b.id === selectedBankId)?.name || 'بنك غير معروف',
              createdAt: serverTimestamp()
          });
          setFeedbackSubmitted(true);
      } catch (err: any) {
          console.error(err.message || err);
      }
  };

      const resumeBank = (bankId: string) => {
          const savedState = localStorage.getItem('tamrediano_exam_state');
          if (savedState) {
              const parsed = JSON.parse(savedState);
              if (parsed.bankId === bankId) {
                  setSelectedBankId(parsed.bankId);
                  setQuestions(parsed.questions);
                  setSelectedAnswers(parsed.selectedAnswers || {});
                  setEssayAnswers(parsed.essayAnswers || {});
                  setEssayChecked(parsed.essayChecked || {});
                  setBookmarked(parsed.bookmarked || {});
                  setCurrentIndex(parsed.currentIndex || 0);
                  const savedTime = localStorage.getItem('tamrediano_exam_time');
                  if (savedTime && !isNaN(parseInt(savedTime))) {
                      setTimeRemaining(parseInt(savedTime));
                  } else {
                      setTimeRemaining(parsed.timeRemaining ?? null);
                  }
                  if (parsed.examMode) setExamMode(parsed.examMode);
                  if (parsed.isFinished) setIsFinished(parsed.isFinished);
                  setShowModeSelect(null);
              }
          }
      };

      const hasSavedSessionForBank = (bankId: string) => {
          try {
              const savedState = localStorage.getItem('tamrediano_exam_state');
              if (savedState) {
                  const parsed = JSON.parse(savedState);
                  if (parsed.bankId === bankId && !parsed.isFinished) return true;
              }
          } catch(e) {}
          return false;
      };

  if (questions.length === 0) {
      if (!selectedBankId) {
          return (
              <div className="min-h-screen bg-[#F8F9FA] text-[#1A1A1A] flex flex-col p-6 font-sans items-center" dir="rtl">
                  <header className="w-full max-w-4xl flex justify-between items-center mb-10 mt-10">
                      <h1 className="text-4xl font-serif italic text-[#D4AF37] tracking-wider drop-shadow-sm" style={{ fontFamily: '"Aref Ruqaa", serif' }}>تمريضيانو</h1>
                      <button onClick={() => { logout(); navigate('/login'); }} className="text-gray-500 hover:text-red-500 text-sm font-bold bg-white border border-gray-200 shadow-sm px-4 py-2 rounded-xl transition-all">
                          تسجيل خروج
                      </button>
                  </header>

                  <div className="max-w-4xl w-full">
                      <h2 className="text-2xl font-bold mb-6 text-gray-800 flex items-center gap-2">
                          <FolderOpen className="text-[#D4AF37]" size={28} />
                          اختر بنك الأسئلة
                      </h2>
                      
                      {(() => {
                          const mistakesKey = `tamrediano_mistakes_${studentData?.fullName || studentData?.name}`;
                          let mistakes = [];
                          try { mistakes = JSON.parse(localStorage.getItem(mistakesKey) || '[]'); } catch(e) {}
                          
                          return mistakes.length > 0 ? (
                              <div className="mb-8">
                                  <div
                                      onClick={() => {
                                          setQuestions(mistakes);
                                          setExamMode('immediate');
                                          setSelectedAnswers({});
                                          setEssayAnswers({});
                                          setEssayChecked({});
                                          setBookmarked({});
                                          setCurrentIndex(0);
                                          setIsFinished(false);
                                          setStartTime(Date.now());
                                      }}
                                      className="bg-white p-6 rounded-2xl border-2 border-red-200 shadow-sm hover:shadow-md hover:border-red-500 transition-all text-right group flex items-start gap-4 w-full relative overflow-hidden cursor-pointer"
                                  >
                                      <div className="absolute top-0 right-0 w-2 h-full bg-red-400" />
                                      <div className="w-14 h-14 bg-red-50 group-hover:bg-red-100 text-red-500 group-hover:text-red-700 rounded-xl flex items-center justify-center transition-colors flex-shrink-0">
                                          <BookX size={28} />
                                      </div>
                                      <div>
                                          <h3 className="font-bold text-gray-900 mb-1 text-lg">كشكول أخطائي ({mistakes.length} سؤال)</h3>
                                          <p className="text-sm text-gray-500">تم تجميع الأسئلة التي تعثرت بها مسبقاً في مكان واحد. راجعها ليلة الامتحان!</p>
                                      </div>
                                      <button 
                                          onClick={(e) => {
                                              e.stopPropagation();
                                              if(confirm('هل أنت متأكد من مسح جميع الأسئلة من كشكول الأخطاء؟')) {
                                                  localStorage.removeItem(mistakesKey);
                                                  window.location.reload();
                                              }
                                          }}
                                          className="absolute top-4 left-4 p-2 text-red-400 hover:text-red-700 hover:bg-red-100 rounded-full transition-colors cursor-pointer"
                                          title="تنظيف كشكول الأخطاء"
                                      >
                                          <Trash size={18} />
                                      </button>
                                      <button 
                                          onClick={async (e) => {
                                              e.stopPropagation();
                                              try {
                                                  const newMistakesDoc = await addDoc(collection(db, 'shared_mistakes'), { questions: mistakes, createdAt: serverTimestamp() });
                                                  const shareUrl = `${window.location.origin}${window.location.pathname}?mistakes=${newMistakesDoc.id}`;
                                                  await navigator.clipboard.writeText(shareUrl);
                                                  alert('تم نسخ رابط بنك الأخطاء المشترك إلى الحافظة! يمكنك مشاركته الآن مع زملائك.');
                                              } catch(err) {
                                                  alert('فشلت عملية المشاركة. تحقق من اتصالك بالإنترنت.');
                                              }
                                          }}
                                          className="absolute top-4 left-14 p-2 text-blue-500 hover:text-blue-700 hover:bg-blue-100 rounded-full transition-colors cursor-pointer"
                                          title="مشاركة كشكول الأخطاء كبنك تدريب"
                                      >
                                          <Share2 size={18} />
                                      </button>
                                  </div>
                                  <div className="w-full border-t border-gray-200 my-6"></div>
                              </div>
                          ) : null;
                      })()}
                      
                      {loadingBanks || loadingQuestions ? (
                          <div className="text-center p-10 bg-white rounded-3xl border border-gray-100 shadow-sm mt-8">
                              <div className="flex flex-col items-center gap-4">
                                 <div className="w-12 h-12 border-4 border-[#D4AF37]/30 border-t-[#D4AF37] rounded-full animate-spin"></div>
                                 <p className="text-gray-600 font-bold animate-pulse">{loadingQuestions ? 'جاري تجهيز الأسئلة، لحظات...' : 'جاري تحميل البنوك المتاحة...'}</p>
                              </div>
                          </div>
                      ) : banks.filter(b => {
                              if (b.isPublic !== false) return true;
                              if (!b.allowedNames) return false;
                              const normalize = (n: string) => n.trim().replace(/\s+/g, ' ');
                              const authName = normalize(studentData?.fullName || studentData?.name || '');
                              const names = b.allowedNames.split('\n').map(normalize).filter((n: string) => n);
                              return names.includes(authName);
                          }).length === 0 ? (
                          <div className="text-center p-10 bg-white rounded-3xl border border-gray-100 shadow-sm">
                              <p className="text-gray-500 font-bold">لا توجد بنوك أسئلة متاحة حالياً.</p>
                          </div>
                      ) : (
                          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                              {banks.filter(b => {
                                  if (b.isPublic !== false) return true;
                                  if (!b.allowedNames) return false;
                                  const normalize = (n: string) => n.trim().replace(/\s+/g, ' ');
                                  const authName = normalize(studentData?.fullName || studentData?.name || '');
                                  const names = b.allowedNames.split('\n').map(normalize).filter((n: string) => n);
                                  return names.includes(authName);
                              }).map(bank => (
                                  <div key={bank.id} className="relative">
                                      <button
                                          onClick={() => setShowModeSelect(bank.id)}
                                          className="w-full bg-white p-6 rounded-2xl border border-gray-200 shadow-sm hover:shadow-md hover:border-[#D4AF37]/50 transition-all text-right group flex flex-col items-start gap-3"
                                      >
                                          <div className="w-12 h-12 bg-[#F8F9FA] group-hover:bg-[#D4AF37]/10 text-gray-400 group-hover:text-[#D4AF37] rounded-xl flex items-center justify-center transition-colors shadow-sm">
                                              <FolderOpen size={24} />
                                          </div>
                                          <div>
                                              <div className="flex items-center gap-2 mb-1">
                                                <h3 className="font-bold text-gray-900">{bank.name}</h3>
                                                {!navigator.onLine && downloadedBanks.includes(bank.id) && <CloudOff size={14} className="text-green-600" />}
                                              </div>
                                              <p className="text-xs text-gray-500 line-clamp-2">انقر لبدء الاختبار</p>
                                          </div>
                                      </button>
                                      {navigator.onLine && !downloadedBanks.includes(bank.id) && (
                                          <button 
                                            onClick={(e) => downloadBankOffline(e, bank.id)}
                                            className="absolute top-4 left-4 p-2 text-gray-400 hover:text-[#D4AF37] bg-gray-50 hover:bg-[#D4AF37]/10 rounded-full transition-colors shadow-sm"
                                            title="تحميل للعمل بدون إنترنت"
                                          >
                                            <Download size={18} />
                                          </button>
                                      )}
                                      {downloadedBanks.includes(bank.id) && (
                                          <div className="absolute top-4 left-4 p-2 text-green-600 bg-green-50 rounded-full shadow-sm" title="محمل مسبقاً">
                                              <Check size={18} />
                                          </div>
                                      )}
                                      <button 
                                        onClick={async (e) => {
                                            e.stopPropagation();
                                            if (downloadingBankId === bank.id) return;
                                            setDownloadingBankId(bank.id);
                                            try {
                                                const qsQuery = query(collection(db, 'live_banks'), where('bankId', '==', bank.id));
                                                const snap = await getDocs(qsQuery);
                                                const qs = snap.docs.map(d => ({id: d.id, ...d.data()})) as any[];
                                                if (qs.length === 0) {
                                                    alert('لا توجد أسئلة لتحميلها');
                                                    setDownloadingBankId(null);
                                                    return;
                                                }

                                                let html = `
                                                    <div style="background: #fff; width: 800px; margin: 0 auto; direction: ltr; font-family: Arial, sans-serif; color: #000; padding: 20px; line-height: 1.5;">
                                                        <!-- Cover Page -->
                                                        <div style="padding: 60px 20px; margin-bottom: 40px; text-align: center; border-bottom: 2px solid #eee; page-break-after: always; break-after: page; direction: rtl;">
                                                            <div style="font-size: 80px; font-weight: bold; color: #D4AF37; margin-bottom: 20px;">T</div>
                                                            <h1 style="color: #1a1a1a; font-size: 42px; margin-bottom: 10px; font-weight: 900;">Tamrediano</h1>
                                                            <h2 style="color: #666; font-size: 24px; margin-bottom: 40px;">تمريضيانو - منصة التمريض</h2>
                                                            <h3 style="color: #1a1a1a; font-size: 32px; margin-bottom: 10px;">${bank.name}</h3>
                                                        </div>
                                                `;

                                                qs.forEach((q, index) => {
                                                    html += `
                                                        <div style="margin-bottom: 30px; page-break-inside: avoid; border-bottom: 1px solid #eee; padding-bottom: 20px;">
                                                            <h3 style="font-size: 18px; color: #1a1a1a; margin-bottom: 15px; text-align: left; direction: ltr;">${index + 1}. ${q.text}</h3>
                                                            ${q.imageUrl ? `<img src="${q.imageUrl}" style="max-height: 250px; display: block; margin: 0 auto 15px auto; border-radius: 8px;" />` : ''}
                                                            <div style="margin-bottom: 15px;">
                                                    `;
                                                    
                                                    (q.options || []).forEach((opt: string, oIndex: number) => {
                                                        html += `
                                                            <div style="padding: 12px; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 8px; font-size: 15px; text-align: left; direction: ltr; background-color: #f8fafc;">
                                                                <strong style="margin-right: 12px; color: #64748b;">${String.fromCharCode(65 + oIndex)}.</strong> <span style="color: #334155;">${opt}</span>
                                                            </div>
                                                        `;
                                                    });

                                                    html += `</div>`;

                                                    if (q.explanation) {
                                                        html += `
                                                            <div style="background-color: #fefce8; border-right: 4px solid #D4AF37; padding: 15px; border-radius: 6px; font-size: 14px; color: #444; direction: rtl; text-align: right;">
                                                                <strong style="display: block; margin-bottom: 8px; color: #000; font-size: 15px;">الإجابة الصحيحة (${String.fromCharCode(65 + q.correct)}) - التوضيح:</strong>
                                                                <div style="line-height: 1.6;">${q.explanation.replace(/\n/g, '<br/>')}</div>
                                                            </div>
                                                        `;
                                                    }

                                                    html += `</div>`;
                                                });

                                                html += `</div>`;
                                                
                                                const html2pdf = await import('html2pdf.js');
                                                await html2pdf.default().set({
                                                    margin: 15,
                                                    filename: `${bank.name || 'Bank'}_Questions.pdf`,
                                                    image: { type: 'jpeg', quality: 1 },
                                                    html2canvas: { scale: 2, useCORS: true, logging: false, scrollY: 0 },
                                                    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
                                                    pagebreak: { mode: ['css', 'avoid-all'] }
                                                }).from(html).save();
                                            } catch (err) {
                                                console.error(err);
                                                alert('فشلت عملية التحميل');
                                            } finally {
                                                setDownloadingBankId(null);
                                            }
                                        }}
                                        className={`absolute bottom-4 left-4 p-2 rounded-full transition-colors shadow-sm flex items-center gap-1 text-[10px] font-bold ${downloadingBankId === bank.id ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : 'text-blue-600 bg-blue-50 hover:bg-blue-100 hover:text-blue-800'}`}
                                        title="تحميل البنك كملف PDF"
                                        disabled={downloadingBankId === bank.id}
                                      >
                                        {downloadingBankId === bank.id ? (
                                            <div className="flex items-center gap-1">
                                                <div className="w-3 h-3 border-2 border-gray-400 border-t-gray-600 rounded-full animate-spin"></div>
                                                يجهز...
                                            </div>
                                        ) : (
                                            <>
                                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="16" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                                                PDF
                                            </>
                                        )}
                                      </button>
                                  </div>
                              ))}
                          </div>
                      )}
                  </div>

                  {/* Mode Select Modal */}
                  <AnimatePresence>
                    {showModeSelect && (
                      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
                        <motion.div 
                          initial={{ scale: 0.95, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          exit={{ scale: 0.95, opacity: 0 }}
                          className="bg-white rounded-3xl p-8 border border-gray-100 shadow-2xl w-full max-w-md text-center"
                        >
                          {banks.find(b => b.id === showModeSelect)?.warningMessage && (
                              <div className="bg-yellow-50 text-orange-800 border border-yellow-200 p-4 rounded-xl mb-6 text-sm font-bold text-right shadow-inner">
                                  <AlertTriangle size={24} className="mb-2 text-orange-500 inline-block ml-2" />
                                  {banks.find(b => b.id === showModeSelect)?.warningMessage}
                              </div>
                          )}
                          <h2 className="text-2xl font-bold mb-2 text-gray-800">اختر نظام الاختبار</h2>
                          <p className="text-gray-500 text-sm mb-8 font-medium">اختر الطريقة التي تفضلها في عرض الإجابات والشرح</p>
                          
                          <div className="space-y-4">
                              {showModeSelect && hasSavedSessionForBank(showModeSelect) && (
                                  <button onClick={() => resumeBank(showModeSelect)} className="w-full bg-[#D4AF37]/10 border-2 border-[#D4AF37] p-5 rounded-2xl text-right transition-all group shadow-sm hover:shadow-md mb-2">
                                      <div className="font-bold text-lg text-gray-900 mb-1">استكمال الاختبار السابق</div>
                                      <div className="text-xs text-gray-700 font-medium">العودة من حيث توقفت آخر مرة.</div>
                                  </button>
                              )}
                              <button onClick={() => { setExamMode('immediate'); loadQuestionsForBank(showModeSelect); }} className="w-full bg-white border-2 border-gray-100 hover:border-[#D4AF37] p-5 rounded-2xl text-right transition-all group shadow-sm hover:shadow-md">
                                  <div className="font-bold text-lg text-gray-800 mb-1 group-hover:text-[#D4AF37]">بدء جديد - فوري (Immediate)</div>
                                  <div className="text-xs text-gray-500 font-medium">يظهر الصح والخطأ والشرح بعد كل سؤال مباشرة. الأفضل للمذاكرة. (سيلغي الحفظ السابق)</div>
                              </button>
                              <button onClick={() => { setExamMode('deferred'); loadQuestionsForBank(showModeSelect); }} className="w-full bg-white border-2 border-gray-100 hover:border-[#D4AF37] p-5 rounded-2xl text-right transition-all group shadow-sm hover:shadow-md">
                                  <div className="font-bold text-lg text-gray-800 mb-1 group-hover:text-[#D4AF37]">بدء جديد - مؤجل (Deferred)</div>
                                  <div className="text-xs text-gray-500 font-medium">تظهر الإجابات والشرح بعد إنهاء الاختبار بالكامل. الأفضل لاختبار مستواك. (سيلغي الحفظ السابق)</div>
                              </button>
                          </div>
                          
                          <button onClick={() => setShowModeSelect(null)} className="mt-6 text-gray-500 hover:text-gray-800 text-sm font-bold transition-colors">إلغاء</button>
                        </motion.div>
                      </div>
                    )}
                  </AnimatePresence>

              </div>
          );
      }

      return (
          <div className="min-h-screen bg-[#F8F9FA] text-[#1A1A1A] flex flex-col justify-center items-center p-6 font-sans">
              <h1 className="text-4xl font-serif italic text-[#D4AF37] tracking-wider mb-6 drop-shadow-sm" style={{ fontFamily: '"Aref Ruqaa", serif' }}>تمريضيانو</h1>
              <div className="bg-white rounded-3xl p-8 border border-gray-100 shadow-[0_10px_40px_-10px_rgba(0,0,0,0.1)] max-w-md text-center w-full">
                  <p className="text-gray-500 font-bold animate-pulse">جاري تحميل الأسئلة...</p>
              </div>
          </div>
      );
  }

  const currentQ = questions[currentIndex];
  const hasAnsweredCurrent = selectedAnswers[currentQ.id] !== undefined;
  const isCorrect = selectedAnswers[currentQ.id] === currentQ.correct;

  if (isFinished) {
      let correctCount = 0;
      const incorrectQs: any[] = [];
      questions.forEach(q => {
          if (q.type === 'essay' || (!q.choices?.length && !q.options?.length)) {
              if (essayChecked[q.id]?.isCorrect) {
                  correctCount++;
              } else {
                  incorrectQs.push(q);
              }
          } else {
              if (selectedAnswers[q.id] === q.correct) {
                  correctCount++;
              } else {
                  incorrectQs.push(q);
              }
          }
      });

      return (
        <div className="min-h-screen bg-[#F8F9FA] text-[#1A1A1A] flex flex-col font-sans overflow-y-auto p-4 md:p-8" dir="rtl">
            <div className="max-w-3xl mx-auto w-full bg-white rounded-3xl p-8 shadow-[0_10px_40px_-10px_rgba(0,0,0,0.05)] border border-gray-100 space-y-8">
               
               <div className="text-center border-b border-gray-100 pb-8">
                  <h1 className="text-4xl font-serif italic text-[#D4AF37] tracking-wider mb-4 drop-shadow-sm" style={{ fontFamily: '"Aref Ruqaa", serif' }}>تمريضيانو</h1>
                  <h2 className="text-2xl font-bold mb-2 text-gray-800">نتيجة الاختبار</h2>
                  <div className="flex justify-center gap-4 mt-6">
                     <div className="bg-gray-50 border border-gray-200 rounded-2xl p-4 w-32 shadow-sm">
                        <div className="text-3xl font-bold text-[#D4AF37] mb-1">{correctCount} <span className="text-sm text-gray-400">/ {questions.length}</span></div>
                        <div className="text-[10px] text-gray-500 font-bold uppercase tracking-wider">الإجابات الصحيحة</div>
                     </div>
                     <div className="bg-gray-50 border border-gray-200 rounded-2xl p-4 w-32 shadow-sm">
                        <div className="text-3xl font-bold text-gray-600 mb-1">{timeTaken} <span className="text-sm text-gray-400">دقيقة</span></div>
                        <div className="text-[10px] text-gray-500 font-bold uppercase tracking-wider">الوقت المستغرق</div>
                     </div>
                  </div>
               </div>

               {incorrectQs.length > 0 && (
                   <div className="space-y-6">
                       <h3 className="text-xl font-bold text-red-600 border-b border-red-100 pb-2 inline-block">النقاط التي أخطأت فيها ({incorrectQs.length})</h3>
                       
                       <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                           <button onClick={handleGenerateStudyGuide} disabled={generatingGuide} className="bg-gradient-to-r from-[#D4AF37] to-[#C5A059] text-white font-bold py-3 px-6 rounded-xl flex items-center gap-2 transition-all shadow-lg hover:shadow-xl hover:-translate-y-1 duration-300 disabled:opacity-50 disabled:transform-none text-sm">
                               {generatingGuide ? 'جاري التحليل من الذكاء الاصطناعي...' : 'اعرف تذاكر إيه ✨'}
                           </button>
                           {studyGuide && (
                               <button onClick={saveTaskList} className="bg-white hover:bg-gray-50 text-[#1A1A1A] border-2 border-[#D4AF37] shadow-md font-bold py-3 px-6 rounded-xl hover:shadow-lg transition-all duration-300 text-sm">
                                  تحميل كملف نصي (.txt)
                               </button>
                           )}
                       </div>

                       {studyGuide && (
                           <div id="study-guide-content" className="bg-[#fff9e6] border border-[#D4AF37]/30 rounded-2xl p-6 text-gray-800 text-sm leading-relaxed whitespace-pre-wrap shadow-inner font-medium">
                               {studyGuide}
                           </div>
                       )}

                       <div className="space-y-4">
                           {incorrectQs.map((q, idx) => {
                                const studentAns = selectedAnswers[q.id];
                                return (
                               <div key={idx} className="bg-white p-6 rounded-2xl border border-gray-200 shadow-sm space-y-4">
                                    <div className="flex justify-between items-start">
                                       <span className="bg-red-50 text-red-600 border border-red-200 text-[10px] px-2.5 py-1 rounded-lg font-bold">سؤال رقم {questions.indexOf(q) + 1} ({banks.find(b => b.id === q.bankId)?.name || 'مجهول'})</span>
                                    </div>
                                    <p className="font-bold text-[#1A1A1A] leading-relaxed text-sm text-right" dir="auto">{q.text}</p>
                                    {/* Choice options list */}
                                    {q.type === 'essay' || (!q.choices?.length && !q.options?.length) ? (
                                        <div className="space-y-3 mt-3">
                                            <div className="bg-red-50 text-red-900 border border-red-200 p-4 rounded-xl text-sm leading-relaxed">
                                                <strong>إجابتك:</strong><br/>
                                                {essayAnswers[q.id] || 'لا يوجد إجابة'}
                                                {essayChecked[q.id] && (
                                                    <div className="mt-2 text-xs font-bold whitespace-pre-wrap">
                                                        {essayChecked[q.id].feedback}
                                                    </div>
                                                )}
                                            </div>
                                            <div className="bg-green-50 text-green-900 border border-green-200 p-4 rounded-xl text-sm leading-relaxed">
                                                <strong>الإجابة النموذجية:</strong><br/>
                                                {q.explanation}
                                            </div>
                                        </div>
                                    ) : (
                                    <div className="space-y-2 mt-3" dir="rtl">
                                        {(q.choices || q.options?.map((opt: string, i: number) => ({ text: opt, originalIndex: i })) || []).map((choice: any, cIdx: number) => {
                                            const isSelected = studentAns === choice.originalIndex;
                                            const isCorrect = q.correct === choice.originalIndex;
                                            
                                            let choiceClass = "border text-right p-3 rounded-xl text-xs font-bold leading-relaxed w-full flex items-center justify-between ";
                                            if (isCorrect) {
                                                choiceClass += "border-green-300 bg-green-50/70 text-green-800";
                                            } else if (isSelected) {
                                                choiceClass += "border-red-300 bg-red-50/70 text-red-800";
                                            } else {
                                                choiceClass += "border-gray-100 bg-gray-50 text-gray-700 opacity-80";
                                            }
                                            
                                            return (
                                                <div key={cIdx} className={choiceClass}>
                                                    <div className="flex items-center gap-2">
                                                        <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] border font-bold ${
                                                            isCorrect ? "bg-green-600 text-white border-green-700" :
                                                            (isSelected ? "bg-red-600 text-white border-red-700" : "bg-gray-200 text-gray-400 border-gray-300")
                                                        }`}>
                                                            {String.fromCharCode(65 + cIdx)}
                                                        </span>
                                                        <span>{choice.text}</span>
                                                    </div>
                                                    {isCorrect && <span className="bg-green-100 text-green-700 font-black px-2 py-0.5 rounded text-[10px]">الإجابة الصحيحة ✔</span>}
                                                    {isSelected && <span className="bg-red-100 text-red-700 font-black px-2 py-0.5 rounded text-[10px]">إجابتك ✖</span>}
                                                </div>
                                            );
                                        })}
                                    </div>
                                    )}

                                    {/* Explanation card */}
                                    <div className="text-xs text-gray-600 bg-amber-50/40 p-4 rounded-xl border border-amber-100 leading-relaxed shadow-inner font-medium mt-2">
                                        <div className="font-bold text-amber-800 mb-1">💡 التفسير والشرح:</div>
                                        {q.explanation || 'لا يوجد تفسير متاح لهذا السؤال.'}
                                    </div>
                                </div>
                                );
                            })}
                       </div>
                   </div>
               )}

               <div className="border-t border-gray-100 pt-8 mt-8">
                   <h3 className="text-lg font-bold mb-4 text-center text-gray-800">ما رأيك في هذا الاختبار؟</h3>
                   {!feedbackSubmitted ? (
                       <div className="space-y-4 flex flex-col items-center">
                           <div className="flex gap-2">
                               {[1,2,3,4,5].map(star => (
                                   <button key={star} onClick={() => setRating(star)} className={`text-4xl transition-transform hover:scale-110 drop-shadow-sm ${rating >= star ? 'text-[#D4AF37]' : 'text-gray-300'}`}>
                                       ★
                                   </button>
                               ))}
                           </div>
                           <textarea 
                             value={feedback}
                             onChange={e => setFeedback(e.target.value)}
                             placeholder="اكتب تعليقك أو أي ملاحظات هنا (اختياري)..."
                             className="w-full max-w-lg bg-gray-50 border border-gray-200 rounded-xl p-4 text-sm focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] outline-none resize-none h-24 text-gray-800 font-medium"
                           />
                           <button disabled={rating === 0} onClick={handleSubmitFeedback} className="bg-[#1A1A1A] hover:bg-gray-800 text-white font-bold py-3 px-8 rounded-xl transition-all shadow-md disabled:opacity-50">
                               إرسال التقييم
                           </button>
                       </div>
                   ) : (
                       <div className="text-center text-green-700 font-bold bg-green-50 border border-green-200 rounded-xl p-4 shadow-sm">
                           شكراً لتقييمك! بالتوفيق يا دكتور.
                       </div>
                   )}
               </div>

               <div className="flex flex-col md:flex-row justify-center gap-4 mt-8 pt-6 border-t border-gray-100">
                    <button onClick={() => {
                        setIsFinished(false);
                        setSelectedAnswers({});
                        setEssayAnswers({});
                        setEssayChecked({});
                        setCurrentIndex(0);
                        const bankData = banks.find(b => b.id === selectedBankId);
                        setTimeRemaining(bankData?.timeLimit ? bankData.timeLimit * 60 : null);
                        setStartTime(Date.now());
                        localStorage.removeItem('tamrediano_exam_state');
                        localStorage.removeItem('tamrediano_exam_time');
                        window.scrollTo(0,0);
                    }} className="bg-white hover:bg-gray-50 text-[#D4AF37] border-2 border-[#D4AF37] font-bold py-3 px-8 rounded-xl transition-all shadow-md flex items-center justify-center gap-2">
                        <RefreshCw size={18} /> إعادة الاختبار
                    </button>
                    <button onClick={() => {
                        localStorage.removeItem('tamrediano_exam_state');
                        localStorage.removeItem('tamrediano_exam_time');
                        window.location.href = '/exam'; 
                    }} className="bg-gray-100 hover:bg-gray-200 text-gray-800 font-bold py-3 px-8 rounded-xl transition-all shadow-md flex items-center justify-center gap-2">
                        <LogOut size={18} /> الرجوع للواجهة الرئيسية
                    </button>
               </div>

            </div>
        </div>
      );
  }

  if (isBannedState) {
     return (
        <div className="min-h-screen bg-red-600 flex flex-col items-center justify-center p-6 text-white text-center" dir="rtl">
           <ShieldAlert size={80} className="mb-6 opacity-90" />
           <h1 className="text-4xl font-bold mb-4">حسابك محظور من النظام</h1>
           <p className="text-xl mb-8 opacity-80">تم حظر هذا الحساب نهائياً بسبب انتهاكات متكررة للسياسات أو الدخول من أجهزة متعددة.</p>
           <button onClick={() => { logout(); navigate('/login'); }} className="bg-white text-red-600 px-8 py-3 rounded-xl font-bold hover:bg-gray-100 transition-colors shadow-xl">
              العودة وتسجيل الخروج
           </button>
        </div>
     );
  }

  return (
    <div 
       className={`min-h-screen font-sans pb-24 transition-colors ${themeMode === 'light' ? 'bg-[#F8F9FA] text-[#1A1A1A]' : themeMode === 'dark' ? 'bg-[#121212] text-[#E0E0E0] dark-mode' : 'bg-[#FFF8E7] text-[#3e2723]'}`} 
       dir="rtl"
       style={{ filter: `brightness(${brightness}%)` }}
    >
      
      {/* Settings Modal */}
      <AnimatePresence>
        {showSettings && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-2xl p-6 border border-gray-200 shadow-2xl w-full max-w-sm"
            >
              <div className="flex justify-between items-center mb-6 border-b border-gray-100 pb-2">
                 <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2"><Settings size={20} className="text-[#D4AF37]"/> إعدادات الاختبار</h2>
                 <button onClick={() => {
                     setShowSettings(false);
                     if (displayName && displayName !== studentData?.name) {
                         const newData = { ...studentData, name: displayName, fullName: displayName };
                         // @ts-ignore
                         loginStudent(newData);
                     }
                 }} className="text-gray-400 hover:text-gray-700 bg-gray-50 border border-gray-200 rounded-full p-1"><X size={16}/></button>
              </div>
              
              <div className="space-y-5">
                 <div>
                    <label className="block text-sm font-bold text-gray-700 mb-1">اسم العرض</label>
                    <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)} className="w-full bg-[#FAF9F6] border border-gray-200 rounded-xl px-3 py-2.5 text-sm font-bold focus:border-[#D4AF37] outline-none" />
                 </div>
                 
                 <div>
                    <label className="block text-sm font-bold text-gray-700 mb-3">نمط الشاشة</label>
                    <div className="flex gap-2">
                       <button onClick={() => setThemeMode('light')} className={`flex-1 py-2 rounded-xl text-sm font-bold border ${themeMode === 'light' ? 'border-[#D4AF37] bg-white text-[#D4AF37]' : 'border-gray-200 bg-gray-50 text-gray-500'}`}><Sun size={14} className="inline mr-1"/> ساطع</button>
                       <button onClick={() => setThemeMode('sepia')} className={`flex-1 py-2 rounded-xl text-sm font-bold border ${themeMode === 'sepia' ? 'border-[#D4AF37] bg-white text-[#D4AF37]' : 'border-gray-200 bg-gray-50 text-gray-500'}`}><Sun size={14} className="inline mr-1"/> دافئ</button>
                       <button onClick={() => setThemeMode('dark')} className={`flex-1 py-2 rounded-xl text-sm font-bold border ${themeMode === 'dark' ? 'border-[#D4AF37] bg-[#1e1e1e] text-[#D4AF37]' : 'border-gray-200 bg-gray-50 text-gray-500'}`}><Moon size={14} className="inline mr-1"/> داكن</button>
                    </div>
                 </div>

                 <div>
                    <label className="block text-sm font-bold text-gray-700 mb-1">السطوع ({brightness}%)</label>
                    <input type="range" min="50" max="100" value={brightness} onChange={e => setBrightness(Number(e.target.value))} className="w-full accent-[#D4AF37]" />
                 </div>

                 <div className="pt-4 border-t border-gray-100">
                    <button onClick={() => {
                        localStorage.removeItem('tamrediano_chat_history'); 
                        alert('تم التنظيف بنجاح. البنوك المحملة أوفلاين لم تتأثر.');
                        window.location.reload();
                    }} className="w-full bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 font-bold py-2 rounded-xl text-sm transition-colors flex items-center justify-center gap-2">
                       <Trash size={16} /> تنظيف الذاكرة المؤقتة لسرعة التطبيق
                    </button>
                 </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Admin Upgrade Modal */}
      <AnimatePresence>
        {showAdminUpgrade && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-2xl p-6 border border-gray-200 shadow-2xl w-full max-w-sm"
            >
              <h2 className="text-xl font-bold mb-4 text-[#D4AF37] font-serif italic" style={{ fontFamily: '"Aref Ruqaa", serif' }}>دخول الإدارة</h2>
              <input
                type="password"
                placeholder="كلمة المرور"
                value={adminPassword}
                onChange={e => setAdminPassword(e.target.value)}
                className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-gray-900 focus:outline-none focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] mb-4 text-left font-medium"
                autoFocus
              />
              <div className="flex gap-2">
                <button onClick={handleAdminUpgrade} className="bg-[#D4AF37] hover:bg-[#C5A059] text-white flex-1 py-2 rounded-xl font-bold transition-all shadow-md">تأكيد</button>
                <button onClick={() => setShowAdminUpgrade(false)} className="bg-gray-100 hover:bg-gray-200 text-gray-700 flex-1 py-2 rounded-xl font-bold transition-all border border-gray-200 shadow-sm">إلغاء</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Top Header */}
      <header className={`sticky top-0 z-10 border-b border-gray-200 px-4 py-3 flex items-center justify-between shadow-sm ${themeMode === 'light' ? 'bg-white' : 'bg-[#fffdf7]'}`}>
        <div className="flex items-center gap-3">
            <button onClick={() => { setSelectedBankId(null); setQuestions([]); }} className="bg-gray-100 hover:bg-gray-200 text-gray-700 p-2 rounded-full transition-colors shadow-sm">
                <ChevronRight size={16} />
            </button>
            <h1 className="text-2xl font-serif italic text-[#D4AF37] tracking-wider drop-shadow-sm" style={{ fontFamily: '"Aref Ruqaa", serif' }}>تمريضيانو</h1>
        </div>
        <div className="flex items-center gap-2 sm:gap-4 text-xs font-mono font-bold text-gray-600 flex-wrap justify-end">
           {timeRemaining !== null && (
               <span className={`px-2 py-1 rounded font-bold ${timeRemaining < 60 ? 'bg-red-100 text-red-600 animate-pulse' : 'bg-gray-100 text-gray-700'}`}>
                   {Math.floor(timeRemaining / 60)}:{String(timeRemaining % 60).padStart(2, '0')}
               </span>
           )}
           <button onClick={() => setShowSettings(true)} className="flex text-[10px] bg-gray-50 hover:bg-gray-100 border border-gray-200 text-gray-600 px-2 sm:px-3 py-1 sm:py-1.5 rounded-full transition-all shadow-sm items-center gap-1 shrink-0">
             <Settings size={12}/> <span className="hidden sm:inline-block">الإعدادات</span>
           </button>
           <button onClick={() => setShowAdminUpgrade(true)} className="flex text-[10px] bg-gray-50 hover:bg-gray-100 border border-gray-200 text-gray-600 px-2 sm:px-3 py-1 sm:py-1.5 rounded-full transition-all shadow-sm items-center shrink-0">
             <span>إدارة</span>
           </button>
           <span className="shrink-0">{Math.round(((currentIndex) / questions.length) * 100)}%</span>
        </div>
      </header>

      {/* Progress Bar */}
      <div className="w-full h-1 bg-gray-200">
        <div 
          className="h-full bg-gradient-to-r from-[#D4AF37] to-[#e4c868] transition-all duration-300 shadow-[0_0_10px_rgba(212,175,55,0.4)]"
          style={{ width: `${((currentIndex + 1) / questions.length) * 100}%` }}
        />
      </div>

      {/* Question Carousel Navigator */}
      <div className="px-4 py-3 overflow-x-auto whitespace-nowrap flex gap-2 bg-white border-b border-gray-100 shadow-sm nav-scroll">
        {questions.map((q, idx) => {
          const answered = selectedAnswers[q.id] !== undefined;
          const correct = selectedAnswers[q.id] === q.correct;
          const isBookmarked = bookmarked[q.id];
          
          return (
            <button
              key={q.id}
              onClick={() => setCurrentIndex(idx)}
              className={cn(
                "w-10 h-10 rounded flex-shrink-0 flex items-center justify-center font-bold text-xs transition-colors border shadow-sm",
                currentIndex === idx ? "bg-[#D4AF37] text-white border-[#D4AF37]" : "bg-white text-gray-500 border-gray-200 hover:bg-gray-50",
                examMode === 'immediate' && answered && correct && currentIndex !== idx && "bg-green-50 text-green-700 border-green-200",
                examMode === 'immediate' && answered && !correct && currentIndex !== idx && "bg-red-50 text-red-700 border-red-200",
                examMode === 'deferred' && answered && currentIndex !== idx && "bg-[#D4AF37]/10 text-[#D4AF37] border-[#D4AF37]/30",
                isBookmarked && currentIndex !== idx && "bg-yellow-50 text-yellow-700 border-yellow-200"
              )}
            >
              {idx + 1}
            </button>
          );
        })}
      </div>

      {/* Question Container */}
      <main className="px-4 py-8 max-w-2xl mx-auto w-full">
        <AnimatePresence mode="wait">
          <motion.div
            key={currentQ.id}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            className="bg-white rounded-2xl p-6 shadow-[0_10px_40px_-10px_rgba(0,0,0,0.05)] border border-gray-100"
          >
            <div className="flex justify-between items-start mb-6">
              <span className="px-3 py-1 rounded-full bg-gray-50 text-gray-600 border border-gray-200 text-[10px] font-bold uppercase tracking-widest shadow-sm">السؤال {String(currentIndex + 1).padStart(2, '0')}</span>
              <div className="flex gap-2">
                  <button 
                    onClick={() => setShowSupportChat(true)}
                    className="flex items-center gap-2 text-xs font-bold px-3 py-1 rounded-lg border text-blue-600 hover:text-blue-800 bg-white border-blue-200 hover:bg-blue-50 transition-all shadow-sm"
                  >
                    <Headset size={14} />
                    <span>المركز الفني الذكي</span>
                  </button>
                  <button 
                    onClick={() => setShowReportModal(true)}
                    className="flex items-center gap-2 text-xs font-bold px-3 py-1 rounded-lg border text-red-500 hover:text-red-700 bg-white border-red-200 hover:bg-red-50 transition-all shadow-sm"
                  >
                    <AlertTriangle size={14} />
                    <span>إبلاغ</span>
                  </button>
                  <button 
                    onClick={() => toggleBookmark(currentQ.id)}
                    className={cn("flex items-center gap-2 text-xs font-bold px-3 py-1 rounded-lg border transition-all shadow-sm", bookmarked[currentQ.id] ? "text-[#D4AF37] bg-yellow-50 border-[#D4AF37]/30" : "text-gray-500 hover:text-gray-700 bg-white border-gray-200 hover:bg-gray-50")}
                  >
                    <Bookmark size={14} className={bookmarked[currentQ.id] ? "fill-current" : ""} />
                    <span>حفظ للمراجعة</span>
                  </button>
              </div>
            </div>
            
            <h2 className="text-xl font-bold text-gray-900 leading-relaxed mb-6" dir="auto">
              {currentQ.text}
            </h2>

            {currentQ.imageUrl && (
              <div 
                className="mb-6 relative rounded-xl overflow-hidden border border-gray-200 shadow-sm group bg-gray-100 cursor-pointer"
                onClick={() => setLightboxImage(currentQ.imageUrl)}
              >
                <img 
                  src={currentQ.imageUrl} 
                  alt="مرفق السؤال" 
                  className="w-full h-auto object-cover dim-image transition-transform group-hover:scale-105"
                />
                <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                   <Maximize2 className="text-white drop-shadow-md" size={32} />
                </div>
              </div>
            )}

            {currentQ.type === 'essay' || (!currentQ.choices?.length && !currentQ.options?.length) ? (
              <div className="space-y-4">
                  <textarea 
                      value={essayAnswers[currentQ.id] || ''}
                      onChange={e => setEssayAnswers(prev => ({...prev, [currentQ.id]: e.target.value}))}
                      disabled={hasAnsweredCurrent}
                      placeholder="اكتب إجابتك هنا..."
                      className="w-full bg-[#FAF9F6] border border-gray-200 rounded-xl p-4 text-sm text-gray-900 focus:border-[#D4AF37] resize-none outline-none font-medium h-32"
                  />
                  {!hasAnsweredCurrent && (
                     <button 
                         onClick={() => handleCheckEssay(currentQ.id)}
                         className="bg-[#D4AF37] text-white px-6 py-2 rounded-xl font-bold shadow-md hover:bg-[#C5A059] transition-colors"
                     >
                         فحص الإجابة بالذكاء الاصطناعي
                     </button>
                  )}
                  {essayChecked[currentQ.id] && (
                     <div className={cn("p-4 rounded-xl border text-sm leading-relaxed", essayChecked[currentQ.id].isCorrect ? "bg-green-50 border-green-200 text-green-800" : "bg-red-50 border-red-200 text-red-800")}>
                         <div className="font-bold flex items-center gap-2 mb-2">
                             {essayChecked[currentQ.id].isCorrect ? <Check size={18}/> : <AlertTriangle size={18}/>}
                             {essayChecked[currentQ.id].isCorrect ? "إجابة صحيحة أو قريبة!" : "راجع إجابتك."}
                         </div>
                         {essayChecked[currentQ.id].feedback}
                     </div>
                  )}
              </div>
            ) : (
            <div className="space-y-3">
              {currentQ.choices?.map((choice: any, idx: number) => {
                const isSelected = selectedAnswers[currentQ.id] === choice.originalIndex;
                const isActualCorrect = choice.originalIndex === currentQ.correct;
                
                let btnClass = "border border-gray-200 bg-white hover:bg-gray-50 transition-colors text-right flex items-center group shadow-sm";
                
                if (hasAnsweredCurrent) {
                  if (examMode === 'immediate') {
                      if (isSelected && isActualCorrect) {
                         btnClass = "border border-green-400 bg-green-50 text-right flex items-center shadow-sm";
                      } else if (isSelected && !isActualCorrect) {
                         btnClass = "border border-red-400 bg-red-50 text-right flex items-center shadow-sm";
                      } else if (isActualCorrect) {
                         btnClass = "border border-green-400 bg-green-50 text-right flex items-center shadow-sm";
                      } else {
                         btnClass = "border border-gray-100 bg-gray-50 opacity-60 text-right flex items-center shadow-none";
                      }
                  } else {
                      // Deferred Mode
                      if (isSelected) {
                         btnClass = "border border-[#D4AF37] bg-[#D4AF37]/10 text-right flex items-center shadow-sm";
                      } else {
                         btnClass = "border border-gray-100 bg-gray-50 opacity-60 text-right flex items-center shadow-none";
                      }
                  }
                }

                let spanClass = "bg-gray-50 group-hover:bg-[#D4AF37]/10 text-gray-600 group-hover:text-[#D4AF37] border border-gray-200 group-hover:border-[#D4AF37]/30";
                if (hasAnsweredCurrent) {
                    if (examMode === 'immediate') {
                         spanClass = isActualCorrect ? "bg-green-600 text-white border-green-700" : (isSelected && !isActualCorrect ? "bg-red-600 text-white border-red-700" : "bg-gray-100 text-gray-400 border-gray-200");
                    } else {
                         spanClass = isSelected ? "bg-[#D4AF37] text-white border-[#D4AF37]" : "bg-gray-100 text-gray-400 border-gray-200";
                    }
                }

                const isCrossedOut = (crossedOutOptions[currentQ.id] || []).includes(choice.originalIndex);

                return (
                  <div key={idx} className="relative flex items-center gap-2 w-full">
                    <button
                      disabled={hasAnsweredCurrent}
                      onClick={() => handleSelectAnswer(currentQ.id, choice.originalIndex)}
                      className={cn(
                        "flex-1 p-4 rounded-xl font-bold text-gray-800 transition-all gap-4",
                        btnClass,
                        isCrossedOut && !hasAnsweredCurrent ? "opacity-30 line-through bg-gray-100 grayscale" : ""
                      )}
                    >
                      <span className={cn(
                        "w-8 h-8 flex items-center justify-center rounded-lg font-mono transition-colors shadow-sm text-sm shrink-0",
                        spanClass
                      )}>
                        {String.fromCharCode(65 + idx)}
                      </span>
                      <span className="leading-relaxed text-right flex-1" dir="auto">{choice.text}</span>
                    </button>
                    {!hasAnsweredCurrent && (
                        <button
                          onClick={(e) => {
                             e.stopPropagation();
                             setCrossedOutOptions(prev => {
                                const arr = prev[currentQ.id] || [];
                                if (arr.includes(choice.originalIndex)) {
                                    return { ...prev, [currentQ.id]: arr.filter(i => i !== choice.originalIndex) };
                                } else {
                                    return { ...prev, [currentQ.id]: [...arr, choice.originalIndex] };
                                }
                             });
                          }}
                          className={cn(
                             "w-12 h-full min-h-[56px] rounded-xl flex items-center justify-center transition-colors border shrink-0 shadow-sm",
                             isCrossedOut ? "bg-gray-200 text-gray-600 border-gray-300 hover:bg-gray-300" : "bg-white text-gray-400 border-gray-200 hover:bg-gray-100 hover:text-red-500"
                          )}
                          title="استبعاد هذه الإجابة"
                        >
                           <EyeOff size={20} />
                        </button>
                    )}
                  </div>
                );
              })}
            </div>
            )}

            <AnimatePresence>
              {hasAnsweredCurrent && examMode === 'immediate' && (
                <motion.div
                  initial={{ opacity: 0, height: 0, marginTop: 0 }}
                  animate={{ opacity: 1, height: 'auto', marginTop: 24 }}
                  className="bg-gray-50 rounded-2xl border border-gray-200 flex flex-col shadow-inner overflow-hidden"
                >
                  <div className="p-4 bg-white border-b border-gray-200 flex items-center gap-3 shadow-sm">
                    <div className="w-8 h-8 rounded-lg bg-[#D4AF37] flex items-center justify-center text-white text-lg font-bold shadow-md">G</div>
                    <div>
                      <div className="text-sm font-bold text-gray-900">الذكاء الاصطناعي (Gemini)</div>
                      <div className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">شرح مبسط للإجابة</div>
                    </div>
                  </div>
                  <div className="flex-1 p-5 flex flex-col gap-4 text-right" dir="rtl">
                    <div className="p-4 bg-white rounded-xl rounded-tr-none text-sm font-medium leading-relaxed text-gray-800 border border-gray-200 shadow-sm">
                      {currentQ.explanation}
                    </div>
                  </div>
                  
                  <div className="p-4 border-t border-gray-200 flex gap-3 bg-white flex-col sm:flex-row">
                    {selectedAnswers[currentQ.id] !== undefined && selectedAnswers[currentQ.id] !== currentQ.correct && (
                        <button 
                          onClick={() => {
                              const selectedText = currentQ.choices.find((c: any) => c.originalIndex === selectedAnswers[currentQ.id])?.text;
                              setChatInput(`ليه الاختيار ده (${selectedText}) غلط؟`);
                              setIsChatOpen(true);
                              setTimeout(() => {
                                  const submitBtn = document.getElementById("ai-chat-submit-btn");
                                  if (submitBtn) submitBtn.click();
                              }, 300);
                          }}
                          className="flex-1 bg-red-50 hover:bg-red-100 text-red-700 shadow-sm border border-red-200 rounded-xl py-2.5 px-4 transition-transform hover:scale-105 font-bold flex items-center justify-center gap-2 text-xs"
                        >
                          🤔 ليه اختياري ده غلط؟
                        </button>
                    )}
                    <button 
                      onClick={() => setIsChatOpen(true)}
                      className="flex-1 bg-white hover:bg-gray-50 text-gray-800 shadow-sm border border-gray-200 rounded-xl py-2.5 px-4 transition-transform hover:scale-105 font-bold flex items-center justify-center gap-2 text-xs"
                    >
                      🗣️ ناقش الذكاء الاصطناعي
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </AnimatePresence>
        
        {/* Navigation Buttons for Previous / Next */}
        <div className="flex flex-wrap justify-between items-center mt-8 max-w-2xl mx-auto w-full gap-4">
            <button 
             onClick={() => setCurrentIndex(Math.max(0, currentIndex - 1))}
             disabled={currentIndex === 0}
             className="px-6 py-3 rounded-xl font-bold bg-white text-gray-700 hover:text-gray-900 border border-gray-200 hover:bg-gray-50 shadow-sm transition-all disabled:opacity-50 flex-1 min-w-[120px]"
            >
                السابق
            </button>
            
            {currentIndex === questions.length - 1 ? (
                <button 
                 onClick={finishExam}
                 className="px-8 py-3 rounded-xl font-bold bg-gradient-to-r from-[#D4AF37] to-[#C5A059] text-white hover:shadow-xl hover:-translate-y-1 transition-all duration-300 shadow-lg flex-1 min-w-[120px]"
                >
                    إنهاء الاختبار
                </button>
            ) : (
                <button 
                 onClick={() => setCurrentIndex(Math.min(questions.length - 1, currentIndex + 1))}
                 disabled={currentIndex === questions.length - 1}
                 className="px-8 py-3 rounded-xl font-bold bg-[#1A1A1A] text-white hover:bg-black disabled:opacity-50 transition-all shadow-md flex-1 min-w-[120px]"
                >
                    التالي
                </button>
            )}
        </div>
      </main>

      {/* AI Chat Drawer */}
      <AnimatePresence>
        {isChatOpen && (
          <>
            <motion.div 
               initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
               className="fixed inset-0 bg-black/50 z-40 backdrop-blur-sm"
               onClick={() => setIsChatOpen(false)}
            />
            <motion.div
               initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
               transition={{ type: 'spring', damping: 25, stiffness: 200 }}
               className="fixed bottom-0 left-0 right-0 h-[85vh] bg-white border-t border-gray-200 z-50 rounded-t-3xl shadow-[0_-10px_40px_-10px_rgba(0,0,0,0.15)] flex flex-col pt-2 max-w-3xl mx-auto"
            >
               <div className="w-12 h-1.5 bg-gray-300 rounded-full mx-auto mb-2" />
               <div className="px-6 py-4 bg-white border-b border-gray-100 flex justify-between items-center rounded-t-3xl shadow-sm">
                 <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-[#D4AF37] flex items-center justify-center text-white text-lg font-bold shadow-md">G</div>
                    <div>
                      <h2 className="font-bold text-sm text-gray-900">محادثة الذكاء الاصطناعي</h2>
                      <div className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">مبني على Gemini 1.5</div>
                    </div>
                 </div>
                 <div className="flex items-center gap-2">
                    <button onClick={copyChat} className="p-2 text-gray-500 hover:text-gray-800 bg-gray-50 border border-gray-200 rounded-full shadow-sm transition-colors">
                      <Copy size={16} />
                    </button>
                    <button onClick={() => setIsChatOpen(false)} className="p-2 text-gray-500 hover:text-gray-800 bg-gray-50 border border-gray-200 rounded-full shadow-sm transition-colors">
                      <X size={16} />
                    </button>
                 </div>
               </div>

               <div className="flex-1 overflow-y-auto p-6 space-y-4 bg-[#F8F9FA]">
                 {chatMessages.length === 0 && (
                     <div className="text-center text-gray-600 font-bold mt-10 text-xs bg-white border border-gray-200 p-4 rounded-xl shadow-sm inline-block mx-auto flex">
                         اسأل الذكاء الاصطناعي أي سؤال بخصوص السؤال الحالي أو المواد العلمية.
                     </div>
                 )}
                 {chatMessages.map((msg, i) => (
                   <div key={i} className={cn("flex", msg.role === 'user' ? "justify-start" : "justify-end")}>
                     <div className={cn(
                       "max-w-[85%] rounded-xl p-4 text-xs font-bold leading-relaxed text-right shadow-sm",
                       msg.role === 'user' 
                         ? "bg-[#D4AF37] text-white rounded-br-none shadow-[0_4px_14px_0_rgba(212,175,55,0.39)]" 
                         : "bg-white text-gray-800 rounded-bl-none border border-gray-200"
                     )}>
                       {msg.role === 'model' ? (
                          <div className="markdown-body text-gray-800">
                             <ReactMarkdown>{msg.content}</ReactMarkdown>
                          </div>
                       ) : (
                          msg.content
                       )}
                     </div>
                   </div>
                 ))}
                 {isChatLoading && (
                    <div className="flex justify-end">
                       <div className="bg-white border border-gray-200 rounded-xl rounded-bl-none p-4 flex gap-1 items-center shadow-sm">
                          <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-pulse" />
                          <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-pulse" style={{ animationDelay: '0.1s' }} />
                          <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-pulse" style={{ animationDelay: '0.2s' }} />
                       </div>
                    </div>
                 )}
                 <div ref={chatEndRef} />
               </div>

               <div className="p-4 bg-white border-t border-gray-100 shadow-[0_-4px_10px_-10px_rgba(0,0,0,0.1)]">
                 <form onSubmit={handleChatSubmit} className="flex flex-col gap-2 bg-gray-50 border border-gray-200 rounded-2xl p-2 shadow-inner">
                   {chatFile && (
                     <div className="flex items-center gap-2 bg-gray-200 px-3 py-1.5 rounded-lg self-start text-xs font-bold w-full mx-2 mt-1">
                        <span className="flex-1 truncate">{chatFile.file.name}</span>
                        <button type="button" onClick={() => setChatFile(null)} className="text-red-500 hover:text-red-700 font-bold ml-2">x</button>
                     </div>
                   )}
                   <div className="flex items-center gap-2 w-full">
                     <label className="p-2 text-gray-500 hover:bg-gray-200 hover:text-[#D4AF37] rounded-full cursor-pointer transition-colors shrink-0">
                       <Paperclip size={20} />
                       <input 
                         type="file" 
                         className="hidden" 
                         accept="image/*,application/pdf"
                         onChange={(e) => {
                             const file = e.target.files?.[0];
                             if(file) {
                                if(file.size > 5 * 1024 * 1024) return alert("حجم الملف يجب أن يكون أقل من 5 ميجا.");
                                const reader = new FileReader();
                                reader.onload = () => {
                                   const base64 = (reader.result as string).split(',')[1];
                                   setChatFile({ file, base64, mimeType: file.type });
                                };
                                reader.readAsDataURL(file);
                             }
                         }}
                       />
                     </label>
                     <input 
                       type="text" 
                       value={chatInput} 
                       onChange={e => setChatInput(e.target.value)}
                       placeholder="اسأل سؤالك هنا..." 
                       className="flex-1 bg-transparent border-none focus:ring-0 outline-none text-gray-900 text-sm font-bold placeholder-gray-500"
                     />
                     <button 
                       id="ai-chat-submit-btn"
                       type="submit" 
                       disabled={(!chatInput.trim() && !chatFile) || isChatLoading}
                       className="bg-[#1A1A1A] hover:bg-black text-white p-2.5 rounded-full transition-transform hover:scale-105 disabled:opacity-50 shadow-md shrink-0"
                     >
                       <Send size={16} className="rotate-180" />
                     </button>
                   </div>
                 </form>
               </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Lightbox / Zoom */}
      <AnimatePresence>
         {lightboxImage && (
            <motion.div
               initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
               className="fixed inset-0 z-[100] bg-white/95 flex flex-col backdrop-blur-md"
            >
               <div className="p-4 flex justify-end">
                  <button onClick={() => setLightboxImage(null)} className="text-gray-600 p-2 bg-gray-100 rounded-full hover:bg-gray-200 transition-colors shadow-sm">
                     <X size={24} />
                  </button>
               </div>
               <div className="flex-1 flex items-center justify-center p-4 overflow-auto">
                  <img src={lightboxImage} alt="Fullscreen" className="max-w-full max-h-[85vh] object-contain rounded-xl dim-image border border-gray-200 shadow-2xl" />
               </div>
            </motion.div>
         )}
      </AnimatePresence>

      {/* Mobile Bottom Navigation Bar */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-[35] bg-white border-t border-gray-200 flex items-center justify-between pb-4 pt-2 px-6 shadow-[0_-10px_30px_-10px_rgba(0,0,0,0.1)]">
         <button onClick={() => setCurrentIndex(Math.max(0, currentIndex - 1))} disabled={currentIndex === 0} className="p-3 text-gray-500 hover:bg-gray-50 rounded-full transition-colors disabled:opacity-30">
            <ChevronRight size={26} />
         </button>
         
         <button onClick={() => {
            quitExam();
         }} className="flex flex-col items-center p-2 text-gray-400 hover:text-[#D4AF37] transition-colors rounded-xl">
            <LayoutList size={22} />
            <span className="text-[10px] font-bold mt-1">البنوك</span>
         </button>

         <button onClick={() => setIsChatOpen(true)} className="relative flex flex-col items-center p-2 text-white bg-gradient-to-tr from-[#D4AF37] to-[#C5A059] rounded-2xl shadow-lg -mt-10 border-[4px] border-[#F8F9FA] hover:scale-105 transition-transform">
            <Bot size={28} className="m-1.5" />
         </button>

         <button onClick={() => setShowSettings(true)} className="flex flex-col items-center p-2 text-gray-400 hover:text-[#D4AF37] transition-colors rounded-xl">
            <Settings size={22} />
            <span className="text-[10px] font-bold mt-1">إعدادات</span>
         </button>
         
         <button onClick={() => setCurrentIndex(Math.min(questions.length - 1, currentIndex + 1))} disabled={currentIndex === questions.length - 1} className="p-3 text-gray-500 hover:bg-gray-50 rounded-full transition-colors disabled:opacity-30">
            <ChevronLeft size={26} />
         </button>
      </div>

      {/* Report Modal */}
      {showReportModal && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
             <div className="bg-white w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden animate-in zoom-in-95">
                <div className="p-4 border-b border-gray-100 flex justify-between items-center bg-red-50">
                   <h3 className="font-bold text-red-600 flex items-center gap-2"><AlertTriangle size={18} /> تفاصيل البلاغ عن السؤال</h3>
                   <button onClick={() => setShowReportModal(false)} className="text-gray-400 hover:text-gray-700 bg-white p-1 rounded-full"><X size={16} /></button>
                </div>
                <div className="p-6 space-y-4">
                   <div className="bg-gray-50 border border-gray-100 p-4 rounded-xl">
                      <p className="font-bold text-sm text-gray-800 mb-2">نص السؤال:</p>
                      <p className="text-xs text-gray-600 leading-relaxed">{questions[currentIndex]?.text}</p>
                   </div>
                   <div>
                       <label className="block text-sm font-bold text-gray-700 mb-2">ما هي المشكلة بالتحديد؟</label>
                       <textarea 
                           className="w-full bg-white border border-gray-200 rounded-xl p-3 text-sm focus:border-red-500 outline-none h-32 resize-none"
                           placeholder="مثال: الإجابة الصحيحة غير مدرجة، أو هناك خطأ إملائي يغير المعنى..."
                           value={reportReason}
                           onChange={e => setReportReason(e.target.value)}
                       />
                   </div>
                </div>
                <div className="p-4 border-t border-gray-100 flex justify-end gap-3 bg-gray-50">
                    <button onClick={() => setShowReportModal(false)} className="px-5 py-2 rounded-xl text-sm font-bold text-gray-600 hover:bg-gray-200 transition-colors">إلغاء</button>
                    <button 
                        onClick={() => {
                            if (!reportReason.trim()) return alert('الرجاء كتابة تفاصيل المشكلة');
                            const currentQ = questions[currentIndex];
                            addDoc(collection(db, 'reports'), {
                                studentId,
                                studentName: studentData?.fullName || studentData?.name || 'غير معروف',
                                questionId: currentQ?.id || '',
                                bankId: selectedBankId,
                                bankName: banks.find(b => b.id === selectedBankId)?.name || 'غير معروف',
                                questionText: currentQ?.text || '',
                                questionOptions: currentQ?.options || [],
                                questionAnswerIndex: currentQ?.correct || 0,
                                questionAnswerText: currentQ?.options?.[currentQ?.correct] || '',
                                message: reportReason,
                                aiChatHistory: chatMessages.length > 0 ? chatMessages : [],
                                createdAt: serverTimestamp(),
                                isRead: false
                            });
                            alert('تم إرسال بلاغك حول السؤال للإدارة، شكراً لك!');
                            setShowReportModal(false);
                            setReportReason('');
                        }} 
                        className="px-5 py-2 rounded-xl text-sm font-bold bg-red-600 hover:bg-red-700 text-white transition-colors flex items-center gap-2"
                    >
                        <Send size={16} /> إرسال البلاغ
                    </button>
                </div>
             </div>
          </div>
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
                 {supportChatMessages.length === 0 && (
                   <div className="flex flex-col gap-2 mt-4 px-2">
                      <button type="button" onClick={(e) => handleSendSupportMessage(e, "توضيح جزئية في المنهج")} className="bg-white border border-gray-200 p-3 rounded-xl text-xs font-bold text-gray-700 hover:border-[#D4AF37] hover:text-[#D4AF37] text-right transition-colors shadow-sm">توضيح جزئية في المنهج</button>
                      <button type="button" onClick={(e) => handleSendSupportMessage(e, "مشكلة في بنك الأسئلة")} className="bg-white border border-gray-200 p-3 rounded-xl text-xs font-bold text-gray-700 hover:border-[#D4AF37] hover:text-[#D4AF37] text-right transition-colors shadow-sm">مشكلة في بنك الأسئلة</button>
                      <button type="button" onClick={(e) => handleSendSupportMessage(e, "مشكلة تقنية أخرى")} className="bg-white border border-gray-200 p-3 rounded-xl text-xs font-bold text-gray-700 hover:border-[#D4AF37] hover:text-[#D4AF37] text-right transition-colors shadow-sm">مشكلة تقنية أخرى</button>
                   </div>
                 )}
                 {supportChatMessages.map(msg => {
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
                         {options.length > 0 && msg.id === supportChatMessages[supportChatMessages.length - 1].id && (
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
                 <div ref={supportChatEndRef} />
              </div>

              {/* Input Area */}
              <div className="p-3 bg-white border-t border-gray-100">
                 <form onSubmit={e => handleSendSupportMessage(e)} className="flex gap-2">
                    <input 
                       value={supportMessage}
                       onChange={e => setSupportMessage(e.target.value)}
                       placeholder="اكتب رسالتك للإدارة هنا..."
                       className="flex-1 bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:border-[#D4AF37] outline-none"
                    />
                    <button type="submit" disabled={(!supportMessage.trim() && !isSupportChatLoading) || isSupportChatLoading} className="bg-[#1A1A1A] hover:bg-black text-white w-12 flex items-center justify-center rounded-xl transition-colors disabled:opacity-50"><Send size={18} /></button>
                 </form>
              </div>
           </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
