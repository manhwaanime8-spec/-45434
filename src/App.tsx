/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import Splash from './pages/Splash';
import Login from './pages/Login';
import Exam from './pages/Exam';
import MobileSplash from './pages/mobile/MobileSplash';
import MobileLogin from './pages/mobile/MobileLogin';
import MobileExam from './pages/mobile/MobileExam';
import AdminLogin from './pages/AdminLogin';
import AdminDashboard from './pages/AdminDashboard';
import { db, handleFirestoreError, OperationType, isFirebasePlaceholder } from './lib/firebase';
import { doc, onSnapshot } from 'firebase/firestore';
import { Toaster, toast } from 'react-hot-toast';
import { useIsMobile } from './hooks/useIsMobile';

const SplashRouter = () => {
  const isMobile = useIsMobile();
  return isMobile ? <MobileSplash /> : <Splash />;
};

const LoginRouter = () => {
  const isMobile = useIsMobile();
  return isMobile ? <MobileLogin /> : <Login />;
};

const ExamRouter = () => {
  const isMobile = useIsMobile();
  return isMobile ? <MobileExam /> : <Exam />;
};

function AppWrapper({ children }: { children: React.ReactNode }) {
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [banned, setBanned] = useState(false);
  const [kickedOut, setKickedOut] = useState(false);
  const [globalAlert, setGlobalAlert] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    if (isFirebasePlaceholder) return;
    
    const unsubGlobal = onSnapshot(doc(db, 'admin_system', 'global_settings'), (snap) => {
        if (snap.exists()) {
            const data = snap.data();
            if (data.global_alert_message) {
                setGlobalAlert(data.global_alert_message);
            } else {
                setGlobalAlert('');
            }

            // Realtime kick for students
            const isAdmin = window.location.pathname.includes('/admin');
            const studentLoginTime = localStorage.getItem('tamrediano_login_time');
            if (!isAdmin && data.force_logout_timestamp && studentLoginTime && data.force_logout_timestamp > Number(studentLoginTime)) {
                localStorage.removeItem('tamrediano_student');
                localStorage.removeItem('tamrediano_exam_state');
                localStorage.removeItem('tamrediano_login_time');
                setKickedOut(true);
            }
        } else {
            setGlobalAlert('');
        }
    });

    // Check maintenance mode
    const unsubConfig = onSnapshot(doc(db, 'system', 'config'), (docSnap) => {
      if (docSnap.exists() && docSnap.data().maintenanceMode) {
        setMaintenanceMode(true);
      } else {
        setMaintenanceMode(false);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, 'system/config');
    });

    // Check ban status for current student and device
    let unsubBan = () => {};
    let unsubDeviceBan = () => {};

    const checkBanStatus = (snapDoc: any) => {
        if (snapDoc.exists() && snapDoc.data().banned) {
            setBanned(true);
        }
    };

    const studentData = localStorage.getItem('tamrediano_student');
    if (studentData) {
      const studentId = JSON.parse(studentData).id;
      unsubBan = onSnapshot(doc(db, 'strikes', studentId), checkBanStatus, (error) => {
        handleFirestoreError(error, OperationType.GET, `strikes/${studentId}`);
      });
    }

    const deviceId = localStorage.getItem('tamrediano_device_id');
    if (deviceId) {
      unsubDeviceBan = onSnapshot(doc(db, 'strikes', deviceId), checkBanStatus, (error) => {
          handleFirestoreError(error, OperationType.GET, `strikes/${deviceId}`);
      });
    }

    return () => {
      unsubGlobal();
      unsubConfig();
      unsubBan();
      unsubDeviceBan();
    };
  }, []);

  useEffect(() => {
    // Anti-copy and Anti-screenshot measures for students
    const isAdmin = window.location.pathname.includes('/admin');
    if (!isAdmin) {
      document.body.style.userSelect = 'none';
      document.body.style.webkitUserSelect = 'none';
      
      const handleContextMenu = (e: MouseEvent) => e.preventDefault();
      const handleKeyDown = (e: KeyboardEvent) => {
          if (e.key === 'PrintScreen') {
              navigator.clipboard?.writeText('');
              document.body.style.display = 'none';
              setTimeout(() => { document.body.style.display = ''; }, 500);
          }
          if ((e.ctrlKey || e.metaKey) && ['c', 'C', 'p', 'P', 's', 'S'].includes(e.key)) {
              e.preventDefault();
          }
      };
      
      document.addEventListener('contextmenu', handleContextMenu);
      document.addEventListener('keydown', handleKeyDown);
      
      // Attempt to obscure screen on visibility change (when taking screenshots via snipping tool sometimes triggers this)
      const handleVisibilityChange = () => {
          if (document.hidden) {
             document.body.style.opacity = '0';
          } else {
             document.body.style.opacity = '1';
          }
      };
      document.addEventListener('visibilitychange', handleVisibilityChange);

      return () => {
          document.body.style.userSelect = '';
          document.body.style.webkitUserSelect = '';
          document.removeEventListener('contextmenu', handleContextMenu);
          document.removeEventListener('keydown', handleKeyDown);
          document.removeEventListener('visibilitychange', handleVisibilityChange);
      };
    }
  }, []);

  if (maintenanceMode) {
    return (
      <div className="min-h-screen bg-[#F8F9FA] text-[#1A1A1A] flex flex-col items-center justify-center p-6 text-center font-sans">
        <h1 className="text-4xl font-serif italic text-[#D4AF37] tracking-wider mb-4" style={{ fontFamily: '"Aref Ruqaa", serif' }}>تمريضيانو</h1>
        <div className="bg-white p-8 rounded-3xl border border-gray-200 max-w-md w-full shadow-[0_10px_40px_-10px_rgba(0,0,0,0.1)]">
           <svg className="w-16 h-16 text-[#D4AF37] mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
           </svg>
           <h2 className="text-xl font-bold mb-2">النظام في حالة صيانة</h2>
           <p className="text-gray-500 text-sm leading-relaxed">نقوم حالياً بترقية وتحديث بنوك الأسئلة. نرجو منكم المحاولة لاحقاً. بالتوفيق يا دكاترة!</p>
        </div>
      </div>
    );
  }

  if (banned) {
    return (
      <div className="min-h-screen bg-[#F8F9FA] text-[#1A1A1A] flex flex-col items-center justify-center p-6 text-center font-sans">
        <h1 className="text-4xl font-serif italic text-red-600 tracking-wider mb-4" style={{ fontFamily: '"Aref Ruqaa", serif' }}>تمريضيانو</h1>
        <div className="bg-white p-8 rounded-3xl border border-red-200 max-w-md w-full shadow-[0_10px_40px_-10px_rgba(0,0,0,0.1)]">
           <svg className="w-16 h-16 text-red-600 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
           </svg>
           <h2 className="text-xl font-bold mb-2 text-red-600">تم حظر الحساب</h2>
           <p className="text-gray-500 text-sm leading-relaxed">لقد تم حظر حسابك وجهازك بشكل نهائي من النظام بسبب مخالفة السلوك أو استخدام ألفاظ نابية متكررة.</p>
        </div>
      </div>
    );
  }

  if (kickedOut) {
    return (
      <div className="min-h-screen bg-[#F8F9FA] text-[#1A1A1A] flex flex-col items-center justify-center p-6 text-center font-sans">
        <h1 className="text-4xl font-serif italic text-orange-600 tracking-wider mb-4" style={{ fontFamily: '"Aref Ruqaa", serif' }}>تمريضيانو</h1>
        <div className="bg-white p-8 rounded-3xl border border-orange-200 max-w-md w-full shadow-[0_10px_40px_-10px_rgba(0,0,0,0.1)]">
           <svg className="w-16 h-16 text-orange-600 mx-auto mb-4 animate-bounce" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
           </svg>
           <h2 className="text-xl font-bold mb-2 text-orange-600">طلب النظام التحديث الإجباري 🚀</h2>
           <p className="text-gray-500 text-sm leading-relaxed mb-6">تم طرد جميع الطلاب بشكل مؤقت من قبل الإدارة لتحديث نظام البنوك وإضافة أسئلة جديدة. يمكنك تسجيل الدخول مرة أخرى الآن!</p>
           <button 
             onClick={() => { setKickedOut(false); navigate('/login', { replace: true }); }} 
             className="w-full bg-orange-600 hover:bg-orange-700 text-white rounded-xl py-3 font-bold shadow-md transition-all active:scale-95"
           >
             تسجيل الدخول مجدداً
           </button>
        </div>
      </div>
    );
  }

  return (
      <div className="relative isolate w-full h-full">
          {globalAlert && (
              <div dir="rtl" className="fixed top-6 left-1/2 -translate-x-1/2 max-w-lg w-[90%] bg-white/95 backdrop-blur-md text-red-600 rounded-2xl p-4 shadow-[0_20px_50px_-12px_rgba(220,38,38,0.25)] font-bold z-[9999] flex items-start sm:items-center gap-4 border border-red-100 animate-in fade-in slide-in-from-top-6 duration-500">
                  <div className="bg-red-50 p-2.5 rounded-full shrink-0 relative">
                     <svg className="w-5 h-5 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                     </svg>
                     <div className="absolute top-0 right-0 w-2.5 h-2.5 bg-red-500 rounded-full border-2 border-red-50 animate-ping" />
                     <div className="absolute top-0 right-0 w-2.5 h-2.5 bg-red-500 rounded-full border-2 border-red-50" />
                  </div>
                  <div className="flex flex-col text-right">
                      <span className="text-[10px] text-red-400 font-black mb-1 tracking-wider">رسالة عاجلة من الإدارة</span>
                      <span className="text-sm leading-snug">{globalAlert}</span>
                  </div>
              </div>
          )}
          {children}
      </div>
  );
}

export default function App() {
  useEffect(() => {
    // Override window.alert globally to use toast
    const originalAlert = window.alert;
    window.alert = (msg) => {
      if (typeof msg === 'string') {
        if (msg.includes('بنجاح') || msg.includes('تم ') || msg.includes('شكراً')) {
          toast.success(msg, { duration: 3000 });
        } else if (msg.includes('فشل') || msg.includes('خطأ') || msg.includes('تعذر') || msg.includes('غير صحيحة') || msg.includes('الرجاء') || msg.includes('حظر')) {
          toast.error(msg, { duration: 4000 });
        } else {
          toast(msg, { duration: 3000 });
        }
      } else {
        originalAlert(msg);
      }
    };
  }, []);

  if (isFirebasePlaceholder) {
    return (
      <div className="min-h-screen bg-[#F8F9FA] text-[#1A1A1A] flex flex-col items-center justify-center p-6 text-center font-sans tracking-tight" dir="rtl">
        <h1 className="text-4xl font-serif italic text-[#D4AF37] tracking-wider mb-4" style={{ fontFamily: '"Aref Ruqaa", serif' }}>تمريضيانو</h1>
        <div className="bg-white p-8 rounded-3xl border border-[#D4AF37]/30 max-w-lg w-full shadow-[0_10px_40px_-5px_rgba(212,175,55,0.08)]">
           <svg className="w-16 h-16 text-[#D4AF37] mx-auto mb-4 animate-bounce" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
           </svg>
           <h2 className="text-xl font-bold mb-3 text-gray-800">تهيئة قاعدة البيانات قيد الانتظار ⏳</h2>
           <p className="text-gray-600 text-sm leading-relaxed mb-6">
             مرحباً بك في <strong className="text-[#D4AF37]">تمريضيانو</strong>! لتفعيل بنوك الأسئلة والنظام بنجاح، يرجى الموافقة على شروط تفعيل Firebase بالضغط على زر <strong>Accept / Approve</strong> في نافذة الدردشة أو في الإشعار الأزرق أعلى منصة AI Studio.
           </p>
           <div className="bg-amber-50 text-amber-900 p-4 rounded-xl text-xs text-right mb-6 border border-amber-100 leading-relaxed font-bold">
             💡 <strong>تنبيه تفعيل الخدمة:</strong> بمجرد نقرك للموافقة على التفعيل في شات الذكاء الاصطناعي، ستقوم المنصة ببناء وتأمين قاعدة بيانات Firestore وتحديث ملف التهيئة تلقائياً. بعد تصفحك للخطوة، اضغط أدناه لإعادة تحميل الصفحة!
           </div>
           <button 
             onClick={() => window.location.reload()} 
             className="w-full bg-[#1A1A1A] hover:bg-black text-white py-3 rounded-xl font-bold text-sm shadow-md transition-all active:scale-95"
           >
             تحديث الصفحة 🔄
           </button>
        </div>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Toaster position="top-center" toastOptions={{ className: 'font-bold rtl', style: { borderRadius: '12px', padding: '16px', color: '#1A1A1A' } }} />
      <Routes>
        <Route path="/" element={<AppWrapper><SplashRouter /></AppWrapper>} />
        <Route path="/login" element={<AppWrapper><LoginRouter /></AppWrapper>} />
        <Route path="/exam" element={<AppWrapper><ExamRouter /></AppWrapper>} />
        <Route path="/admin-login" element={<AdminLogin />} />
        <Route path="/admin-dashboard" element={<AdminDashboard />} />
      </Routes>
    </BrowserRouter>
  );
}
