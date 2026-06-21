import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useNavigate } from 'react-router-dom';

export default function Splash() {
  const navigate = useNavigate();
  const [show, setShow] = useState(true);

  useEffect(() => {
    const splashSeen = localStorage.getItem('splash_seen');
    if (splashSeen) {
      navigate(`/login${window.location.search}`, { replace: true });
      return;
    }

    const timer = setTimeout(() => {
      setShow(false);
      localStorage.setItem('splash_seen', 'true');
      setTimeout(() => navigate(`/login${window.location.search}`, { replace: true }), 500);
    }, 3000);

    return () => clearTimeout(timer);
  }, [navigate]);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#F8F9FA]"
        >
          <motion.h1
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', damping: 10, stiffness: 50, delay: 0.2 }}
            className="text-6xl md:text-8xl font-serif italic text-[#D4AF37] tracking-wider drop-shadow-sm"
            style={{ fontFamily: '"Aref Ruqaa", serif' }}
          >
            تمريضيانو
          </motion.h1>
          <motion.p
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 1 }}
            className="absolute bottom-10 text-gray-400 font-bold uppercase tracking-[0.2em] text-xs"
          >
            FOR NURSING EXCELLENCE
          </motion.p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
