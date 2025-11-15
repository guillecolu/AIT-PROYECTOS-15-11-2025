

'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback, useMemo } from 'react';
import type { Project, Task, User, Part, Stage, CommonTask, AppConfig, UserRole, ProjectAlerts, AlertItem, AreaColor } from '@/lib/types';
import { db, storage, app }from '@/lib/firebase';
import { getAuth, onAuthStateChanged, signInAnonymously, User as FirebaseUser } from 'firebase/auth';
import { collection, getDocs, doc, setDoc, deleteDoc, writeBatch, getDoc, addDoc, updateDoc, onSnapshot, query, Unsubscribe } from "firebase/firestore";
import { ref, uploadBytesResumable, getDownloadURL, deleteObject } from 'firebase/storage';
import * as mime from 'mime-types';
import { startOfDay, endOfDay, addDays, isBefore } from 'date-fns';
import { defaultAreaColors } from '@/lib/colors';
import { Loader2 } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import AutoLoginForm from '@/components/auth/auto-login-form';

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return (
    Math.random().toString(36).slice(2) +
    '-' +
    Date.now().toString(36)
  );
}

interface DataContextProps {
  projects: Project[] | null;
  tasks: Task[] | null;
  users: User[] | null;
  userRoles: UserRole[] | null;
  appConfig: AppConfig;
  areaColors: AreaColor[] | null;
  commonDepartments: string[] | null;
  commonTasks: CommonTask[] | null;
  loading: boolean;
  firebaseUser: FirebaseUser | null;
  getProjectById: (id: string) => Project | undefined;
  getTasksByProjectId: (projectId: string) => Task[];
  getUsers: () => User[];
  saveProject: (project: Omit<Project, 'id'> | Project) => Promise<Project>;
  deleteProject: (projectId: string) => Promise<void>;
  saveTask: (task: Omit<Task, 'id'> | Task) => Promise<Task>;
  deleteTask: (taskId: string) => Promise<void>;
  saveUser: (user: Omit<User, 'id'> | User) => Promise<User>;
  deleteUser: (userId: string) => Promise<void>;
  saveUserRole: (role: UserRole) => Promise<void>;
  deleteUserRole: (role: UserRole) => Promise<void>;
  addPartToProject: (projectId: string, partName?: string) => Promise<Part | null>;
  saveCommonDepartment: (departmentName: string) => void;
  saveCommonTask: (task: CommonTask) => void;
  deleteCommonTask: (taskId: string) => Promise<void>;
  saveAppConfig: (config: Partial<AppConfig>) => Promise<void>;
  saveAreaColor: (colorData: AreaColor) => Promise<void>;
  setProjects: React.Dispatch<React.SetStateAction<Project[] | null>>;
  setUsers: React.Dispatch<React.SetStateAction<User[] | null>>;
  uploadFile: (file: File, path: string, onProgress?: (progress: number) => void) => Promise<string>;
}

const DataContext = createContext<DataContextProps | undefined>(undefined);

export const DataProvider = ({ children }: { children: ReactNode }) => {
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [rawProjects, setRawProjects] = useState<Project[] | null>(null);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [users, setUsers] = useState<User[] | null>(null);
  const [userRoles, setUserRoles] = useState<UserRole[] | null>(null);
  const [appConfig, setAppConfig] = useState<AppConfig>({ logoUrl: null });
  const [areaColors, setAreaColors] = useState<AreaColor[] | null>(null);
  const [commonDepartments, setCommonDepartments] = useState<string[] | null>(null);
  const [commonTasks, setCommonTasks] = useState<CommonTask[] | null>(null);
  const [loading, setLoading] = useState(true);
  
  const router = useRouter();
  const pathname = usePathname();

  const projects = useMemo(() => {
    if (!rawProjects || !tasks) return rawProjects;

    return rawProjects.map(project => {
        const projectTasks = tasks.filter(task => task.projectId === project.id);
        
        let totalProjectEstimatedTime = 0;
        let totalProjectActualTime = 0;
        let totalProjectPendingEstimatedTime = 0;

        const updatedParts = (project.parts || []).map(part => {
            const partTasks = projectTasks.filter(t => t.partId === part.id);
            if (partTasks.length === 0) {
              return { 
                ...part, 
                progress: 0, 
                totalEstimatedTime: 0,
                totalActualTime: 0,
                totalPendingEstimatedTime: 0
              };
            }
            
            const pendingPartTasks = partTasks.filter(t => t.status !== 'finalizada');
            
            const totalPartEstimatedTime = partTasks.reduce((acc, task) => acc + (task.estimatedTime || 0), 0);
            const totalPartActualTime = partTasks.reduce((acc, task) => acc + (task.actualTime || 0), 0);
            const totalPartPendingEstimatedTime = pendingPartTasks.reduce((acc, task) => acc + (task.estimatedTime || 0), 0);
            
            const totalTaskProgress = partTasks.reduce((acc, task) => acc + (task.progress || (task.status === 'finalizada' ? 100 : 0)), 0);
            const newPartProgress = Math.round(totalTaskProgress / partTasks.length);

            totalProjectEstimatedTime += totalPartEstimatedTime;
            totalProjectActualTime += totalPartActualTime;
            totalProjectPendingEstimatedTime += totalPartPendingEstimatedTime;

            return { 
                ...part, 
                progress: newPartProgress, 
                totalEstimatedTime: totalPartEstimatedTime,
                totalActualTime: totalPartActualTime,
                totalPendingEstimatedTime: totalPartPendingEstimatedTime
            };
        });
        
        let newProjectProgress = 0;
        if (updatedParts.length > 0) {
          const totalPartsProgress = updatedParts.reduce((acc, part) => acc + (part.progress || 0), 0);
          newProjectProgress = Math.round(totalPartsProgress / updatedParts.length);
        }
        
        return { 
          ...project, 
          parts: updatedParts, 
          progress: newProjectProgress,
          totalEstimatedTime: totalProjectEstimatedTime,
          totalActualTime: totalProjectActualTime,
          totalPendingEstimatedTime: totalProjectPendingEstimatedTime
        };
    });
  }, [rawProjects, tasks]);


  const uploadFile = async (file: File, path: string, onProgress?: (progress: number) => void): Promise<string> => {
    return new Promise((resolve, reject) => {
        const storageRef = ref(storage, path);
        const contentType = mime.lookup(file.name) || 'application/octet-stream';
        const metadata = { contentType };
        
        const uploadTask = uploadBytesResumable(storageRef, file, metadata);

        uploadTask.on('state_changed',
            (snapshot) => {
                const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
                onProgress?.(progress);
            },
            (error) => {
                console.error("Upload error:", error.code, error.message);
                reject(error);
            },
            async () => {
                try {
                    const downloadURL = await getDownloadURL(uploadTask.snapshot.ref);
                    resolve(downloadURL);
                } catch (error) {
                    reject(error);
                }
            }
        );
    });
  }

  // Effect for handling Firebase Authentication state changes
  useEffect(() => {
    const auth = getAuth(app);
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
          setFirebaseUser(user);
      } else {
          try {
              await signInAnonymously(auth);
          } catch (error: any) {
              console.error("Error al autenticar anónimamente:", error.code, error.message);
          }
      }
    });
    return () => unsubscribe();
  }, []);

  // Effect for fetching data when user is authenticated
  useEffect(() => {
    if (!firebaseUser) return;

    setLoading(true);
    const collectionsToFetch = [
        { name: 'projects', setter: (data: any) => setRawProjects(data as Project[]) },
        { name: 'tasks', setter: (data: any) => setTasks(data as Task[]) },
        { name: 'users', setter: (data: any) => setUsers((data as User[]).sort((a,b) => (a.order || 0) - (b.order || 0))) },
        { name: 'userRoles', setter: (data: any) => {
            const userRolesData = data.map((d: any) => d.name as UserRole);
            const defaultRoles: UserRole[] = ['Admin', 'Manager', 'Oficina Técnica', 'Taller', 'Eléctrico', 'Comercial', 'Dirección de Proyecto', 'Dirección de Área'];
            setUserRoles([...new Set([...defaultRoles, ...userRolesData])]);
        }},
        { name: 'areaColors', setter: (data: any) => {
            if (data.length === 0) {
                setAreaColors(defaultAreaColors);
            } else {
                setAreaColors(data as AreaColor[]);
            }
        }},
        { name: 'commonDepartments', setter: (data: any) => setCommonDepartments(data.map((d: any) => d.name)) },
        { name: 'commonTasks', setter: (data: any) => setCommonTasks(data as CommonTask[]) }
    ];
    
    const unsubscribers: Unsubscribe[] = [];
    let collectionsLoaded = 0;
    const totalCollections = collectionsToFetch.length + 1; // +1 for appConfig

    const onDataLoaded = () => {
        collectionsLoaded++;
        if (collectionsLoaded === totalCollections) {
            setLoading(false);
        }
    };
    
    collectionsToFetch.forEach(({ name, setter }) => {
        const unsub = onSnapshot(query(collection(db, name)), (snapshot) => {
            const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setter(data);
            onDataLoaded();
        }, (error) => {
            console.error(`Error fetching ${name}:`, error);
            onDataLoaded();
        });
        unsubscribers.push(unsub);
    });

    const unsubConfig = onSnapshot(doc(db, "appConfig", "main"), (docSnap) => {
        setAppConfig(docSnap.exists() ? docSnap.data() as AppConfig : { logoUrl: null });
        onDataLoaded();
    }, (error) => {
        console.error("Error fetching appConfig:", error);
        onDataLoaded();
    });
    unsubscribers.push(unsubConfig);
    
    // Initial call in case some collections are empty
    if (collectionsToFetch.length + 1 === 0) setLoading(false);

    return () => unsubscribers.forEach(unsub => unsub());
  }, [firebaseUser]);
    
  useEffect(() => {
    if (!loading && firebaseUser && pathname === '/') {
        router.push('/dashboard');
    }
  }, [loading, firebaseUser, pathname, router]);

  const saveAppConfig = async (configUpdate: Partial<AppConfig>) => {
    const configRef = doc(db, 'appConfig', 'main');
    await setDoc(configRef, configUpdate, { merge: true });
  };

  const saveCommonDepartment = useCallback(async (departmentName: string) => {
    if (commonDepartments?.find(d => d.toLowerCase() === departmentName.toLowerCase())) return;
    const newDocRef = doc(collection(db, "commonDepartments"));
    await setDoc(newDocRef, { name: departmentName });
  }, [commonDepartments]);
  
  const saveCommonTask = useCallback(async (task: CommonTask) => {
    const taskExists = commonTasks?.some(t => 
        t.title.toLowerCase() === task.title.toLowerCase() && 
        t.component.toLowerCase() === task.component.toLowerCase()
    );
    if (taskExists) return;

    const newDocRef = doc(collection(db, "commonTasks"), task.id);
    await setDoc(newDocRef, task);
  }, [commonTasks]);

  const deleteCommonTask = async (taskId: string) => {
    await deleteDoc(doc(db, "commonTasks", taskId));
  };
  
  const addPartToProject = async (projectId: string, partName?: string): Promise<Part | null> => {
      if(!projects) return null;
      const project = projects.find(p => p.id === projectId);
      if (!project) return null;

      const newPart: Part = {
          id: generateId(),
          name: partName || `Nuevo Parte ${project.parts?.length || 0 + 1}`,
          stages: [],
          progress: 0,
      };
      
      const updatedProject = { ...project, parts: [...(project.parts || []), newPart] };
      await saveProject(updatedProject);
      
      return newPart;
  };

  const getProjectById = useCallback((id: string) => projects?.find(p => p.id === id), [projects]);
  const getTasksByProjectId = useCallback((projectId: string) => tasks?.filter(t => t.projectId === projectId) || [], [tasks]);
  const getUsers = useCallback(() => users || [], [users]);

  const saveProject = async (projectData: Omit<Project, 'id'> | Project): Promise<Project> => {
    let updatedProject: Project;
    if ('id' in projectData) {
      updatedProject = { ...projectData };
    } else {
      const newId = doc(collection(db, "projects")).id;
      const order = projects?.length || 0;
      updatedProject = { ...projectData, id: newId, order };
    }
    
    await setDoc(doc(db, "projects", updatedProject.id), updatedProject);

    return updatedProject;
  };

  const deleteProject = async (projectId: string) => {
    if (!tasks) return;
    const batch = writeBatch(db);

    const projectRef = doc(db, "projects", projectId);
    batch.delete(projectRef);

    const tasksToDelete = tasks.filter(t => t.projectId === projectId) || [];
    tasksToDelete.forEach(t => batch.delete(doc(db, "tasks", t.id)));
      
    await batch.commit();
  };
  
  const saveTask = async (taskData: Omit<Task, 'id'> | Task): Promise<Task> => {
    let updatedTask: Task;

    const taskToSave: any = { ...taskData };
    if (taskToSave.assignedToId === undefined) {
      delete taskToSave.assignedToId;
    }

    if ('id' in taskToSave) {
        updatedTask = taskToSave;
    } else {
        const newId = doc(collection(db, "tasks")).id;
        updatedTask = { ...taskToSave, id: newId } as Task;
    }
    
    await setDoc(doc(db, "tasks", updatedTask.id), updatedTask, { merge: true });

    return updatedTask;
  };
  
  const deleteTask = async (taskId: string) => {
    const taskToDelete = tasks?.find(t => t.id === taskId);
    if (!taskToDelete) return;

    await deleteDoc(doc(db, "tasks", taskId));
  };

  const saveUser = async (user: Omit<User, 'id'> | User): Promise<User> => {
    let updatedUser: User;
    if ('id' in user) {
      updatedUser = user;
    } else {
      const newId = doc(collection(db, "users")).id;
      const order = users?.length || 0;
      updatedUser = { ...user, id: newId, order };
    }

    await setDoc(doc(db, "users", updatedUser.id), updatedUser);

    return updatedUser;
  };

  const deleteUser = async (userId: string) => {
    await deleteDoc(doc(db, "users", userId));
    
    if (!tasks) return;
    const tasksToUpdate = tasks.filter(t => t.assignedToId === userId);
    const batch = writeBatch(db);
    tasksToUpdate.forEach(task => {
        const taskRef = doc(db, "tasks", task.id);
        batch.update(taskRef, { assignedToId: "" });
    });
    await batch.commit();
  };
  
  const saveUserRole = async (role: UserRole) => {
    if (userRoles?.includes(role)) return;
    await addDoc(collection(db, "userRoles"), { name: role });
  };

  const deleteUserRole = async (role: UserRole) => {
      const q = (await getDocs(collection(db, "userRoles"))).docs.find(doc => doc.data().name === role);
      if (q) {
          await deleteDoc(q.ref);
      }
  };

  const saveAreaColor = async (colorData: AreaColor) => {
    const colorRef = doc(db, "areaColors", colorData.name);
    await setDoc(colorRef, colorData, { merge: true });
  }

  const value: DataContextProps = {
    projects,
    tasks,
    users,
    userRoles,
    appConfig,
    areaColors,
    commonDepartments,
    commonTasks,
    loading,
    firebaseUser,
    getProjectById,
    getTasksByProjectId,
    getUsers,
    saveProject,
    deleteProject,
    saveTask,
    deleteTask,
    saveUser,
    deleteUser,
    saveUserRole,
    deleteUserRole,
    addPartToProject,
    saveCommonDepartment,
    saveCommonTask,
    deleteCommonTask,
    saveAppConfig,
    saveAreaColor,
    setProjects: setRawProjects,
    setUsers,
    uploadFile,
  };

  if (loading && pathname !== '/') {
       return (
          <div className="flex h-screen w-full items-center justify-center">
              <Loader2 className="h-12 w-12 animate-spin text-primary" />
          </div>
      )
  }
  
  if (loading || (pathname === '/' && !firebaseUser)) {
       return (
          <div className="flex h-screen w-full items-center justify-center">
              <AutoLoginForm />
          </div>
      )
  }

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
};

export const useData = () => {
  const context = useContext(DataContext);
  if (context === undefined) {
    throw new Error('useData must be used within a DataProvider');
  }
  return context;
};

    
