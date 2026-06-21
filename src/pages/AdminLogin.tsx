import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';

const ADMINS = ["عمرو كارم محمود موسى", "Mohammed Abd El Jawwad", "Mohamed Fikry", "Mahmoud", "عمرو كارم محمود"];
const MASTER_PASS = "nursing admins 123";

export default function AdminLogin() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (password === MASTER_PASS && ADMINS.includes(name)) {
      localStorage.setItem('tamrediano_admin', name);
      navigate('/admin-dashboard', { replace: true });
    } else {
      setError('بيانات الدخول غير صحيحة أو ليس لديك صلاحية.');
    }
  };

  return (
    <div className="min-h-screen flex flex-col justify-center bg-[#F8F9FA] text-[#1A1A1A] p-6 font-sans overflow-hidden" dir="rtl">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md bg-white rounded-3xl shadow-[0_10px_40px_-10px_rgba(0,0,0,0.1)] p-8 border border-gray-100 mx-auto"
      >
        <div className="text-center mb-8">
          <h1 className="text-4xl font-serif italic text-[#D4AF37] tracking-wider mb-2" style={{ fontFamily: '"Aref Ruqaa", serif' }}>لوحة التحكم</h1>
          <p className="text-xs uppercase tracking-[0.2em] text-gray-500 font-bold">تمريضيانو - الإدارة المشرفة</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-6">
          <div>
            <label className="block text-xs text-gray-600 mb-2 font-bold">اسم المشرف</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 focus:outline-none focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] text-gray-900 transition-all text-right text-sm font-medium"
              required
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-2 font-bold">كلمة المرور الرئيسية</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 focus:outline-none focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] text-gray-900 transition-all text-right text-sm font-medium"
              required
            />
          </div>

          {error && <p className="text-red-600 text-xs text-center font-bold bg-red-50 py-2 rounded border border-red-100">{error}</p>}

          <button
            type="submit"
            className="w-full bg-[#D4AF37] hover:bg-[#C5A059] text-white text-sm font-bold py-3 rounded-xl transition-all shadow-md disabled:opacity-50"
          >
            دخول المشرف
          </button>
        </form>
      </motion.div>
    </div>
  );
}
