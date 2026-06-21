import React, { createContext, useContext, useState, useEffect } from 'react';

type UserContextType = {
  isAdmin: boolean;
  studentData: any;
  loginAdmin: (name: string) => void;
  loginStudent: (data: any) => void;
  logout: () => void;
};

const AuthContext = createContext<UserContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [isAdmin, setIsAdmin] = useState(() => {
    return !!localStorage.getItem('tamrediano_admin');
  });
  const [studentData, setStudentData] = useState<any>(() => {
    const student = localStorage.getItem('tamrediano_student');
    return student ? JSON.parse(student) : null;
  });

  useEffect(() => {
    // Optionally keep this to listen to across-tab changes if needed, but not necessary for initial render.
  }, []);

  const loginAdmin = (name: string) => {
    localStorage.setItem('tamrediano_admin', name);
    setIsAdmin(true);
  };

  const loginStudent = (data: any) => {
    localStorage.setItem('tamrediano_student', JSON.stringify(data));
    localStorage.setItem('tamrediano_login_time', Date.now().toString());
    setStudentData(data);
  };

  const logout = () => {
    localStorage.removeItem('tamrediano_admin');
    localStorage.removeItem('tamrediano_student');
    localStorage.removeItem('tamrediano_login_time');
    setIsAdmin(false);
    setStudentData(null);
  };

  return (
    <AuthContext.Provider value={{ isAdmin, studentData, loginAdmin, loginStudent, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
};
