import { initializeApp } from "firebase/app";

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyD0jeZyg4ZNv0OZHaKMrdegHyQ1XuIjrqU",
  authDomain: "kotoba-41ab0.firebaseapp.com",
  databaseURL: "https://kotoba-41ab0-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "kotoba-41ab0",
  storageBucket: "kotoba-41ab0.firebasestorage.app",
  messagingSenderId: "792855742091",
  appId: "1:792855742091:web:9734098b8c9e530ac0368e",
  measurementId: "G-Y6EHQP7YTJ"
};

// Initialize Firebase
export const app = initializeApp(firebaseConfig);

