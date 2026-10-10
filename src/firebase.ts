import { initializeApp } from "firebase/app";

const getEnv = (val: string | undefined, fallback: string): string => val || fallback;

export const firebaseConfig = {
  apiKey: getEnv(import.meta.env?.VITE_FIREBASE_API_KEY, "AIzaSyD0jeZyg4ZNv0OZHaKMrdegHyQ1XuIjrqU"),
  authDomain: getEnv(import.meta.env?.VITE_FIREBASE_AUTH_DOMAIN, "kotoba-41ab0.firebaseapp.com"),
  databaseURL: getEnv(import.meta.env?.VITE_FIREBASE_DATABASE_URL, "https://kotoba-41ab0-default-rtdb.asia-southeast1.firebasedatabase.app"),
  projectId: getEnv(import.meta.env?.VITE_FIREBASE_PROJECT_ID, "kotoba-41ab0"),
  storageBucket: getEnv(import.meta.env?.VITE_FIREBASE_STORAGE_BUCKET, "kotoba-41ab0.firebasestorage.app"),
  messagingSenderId: getEnv(import.meta.env?.VITE_FIREBASE_MESSAGING_SENDER_ID, "792855742091"),
  appId: getEnv(import.meta.env?.VITE_FIREBASE_APP_ID, "1:792855742091:web:9734098b8c9e530ac0368e"),
  measurementId: getEnv(import.meta.env?.VITE_FIREBASE_MEASUREMENT_ID, "G-Y6EHQP7YTJ")
};

export const app = initializeApp(firebaseConfig);
