import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

export const firebaseConfig = {
  apiKey: "AIzaSyANQ7dl7TjPpxoKz6vHWH9iiQp609SyQ00",
  authDomain: "simaidb.firebaseapp.com",
  projectId: "simaidb",
  storageBucket: "simaidb.firebasestorage.app",
  messagingSenderId: "108602901271",
  appId: "1:108602901271:web:dccacdccb3ab2b6093ed52",
  measurementId: "G-HN2KCN31FE"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const storage = getStorage(app);
