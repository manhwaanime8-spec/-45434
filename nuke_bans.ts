import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, deleteDoc, updateDoc } from 'firebase/firestore';
import firebaseConfig from './firebase-applet-config.json' assert { type: "json" };

async function nukeAllBans() {
    const app = initializeApp(firebaseConfig);
    const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

    // 1. Delete ALL strikes
    console.log("Deleting all strikes...");
    const strikesSnap = await getDocs(collection(db, 'strikes'));
    for (const d of strikesSnap.docs) {
        await deleteDoc(doc(db, 'strikes', d.id));
        console.log(`Deleted strike: ${d.id}`);
    }

    // 2. Clear users
    console.log("Clearing users...");
    const usersSnap = await getDocs(collection(db, 'users'));
    for (const d of usersSnap.docs) {
        let needsUpdate = false;
        let updateData: any = {};
        const data = d.data();
        if (data.banned === true) {
            updateData.banned = false;
            needsUpdate = true;
        }
        if (data.ips && data.ips.length > 3) {
            updateData.ips = [];
            needsUpdate = true;
        }
        if (needsUpdate) {
            await updateDoc(doc(db, 'users', d.id), updateData);
            console.log(`Updated user: ${d.id}`);
        }
    }

    // 3. Clear allowed_students
    console.log("Clearing allowed_students...");
    const allowedSnap = await getDocs(collection(db, 'allowed_students'));
    for (const d of allowedSnap.docs) {
        let needsUpdate = false;
        let updateData: any = {};
        const data = d.data();
        if (data.banned === true) {
            updateData.banned = false;
            needsUpdate = true;
        }
        if (data.ips && data.ips.length > 3) {
            updateData.ips = [];
            needsUpdate = true;
        }
        if (needsUpdate) {
            await updateDoc(doc(db, 'allowed_students', d.id), updateData);
            console.log(`Updated allowed_student: ${d.id}`);
        }
    }

    console.log("Done nuking bans.");
    process.exit(0);
}

nukeAllBans().catch(console.error);
