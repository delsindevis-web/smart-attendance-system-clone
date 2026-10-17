import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { hashPassword } from './auth.js';

const ALL_DAYS = 'MON,TUE,WED,THU,FRI,SAT,SUN'; // every day, so the demo works whenever you run it

export function seed({ db }) {
  const now = Date.now();
  const addUser = db.prepare('INSERT INTO users (login_id, name, role, password_hash, created_at) VALUES (?,?,?,?,?)');

  const teacher = addUser.run('T001', 'Dr. Rao', 'teacher', hashPassword('teacher123'), now).lastInsertRowid;
  const students = [
    ['23BCS001', 'Aarav Patil'], ['23BCS002', 'Diya Kulkarni'], ['23BCS003', 'Rohan Hegde'],
    ['23BCS004', 'Sneha Naik'], ['23BCS005', 'Karthik Joshi'],
  ].map(([id, name]) => Number(addUser.run(id, name, 'student', hashPassword('student123'), now).lastInsertRowid));

  const addCourse = db.prepare(
    'INSERT INTO courses (code, name, teacher_id, start_time, end_time, days, beacon_id) VALUES (?,?,?,?,?,?,?)'
  );
  const enroll = db.prepare('INSERT INTO enrollments (course_id, student_id) VALUES (?,?)');
  const courses = [
    ['CS101', 'Introduction to Programming', '09:00', '10:00', 'BLE-CS101'],
    ['CN301', 'Computer Networks', '10:00', '11:00', 'BLE-CN301'],
    ['IR302', 'Information Retrieval', '14:00', '15:00', 'BLE-IR302'],
  ];
  for (const [code, name, st, en, beacon] of courses) {
    const id = addCourse.run(code, name, teacher, st, en, ALL_DAYS, beacon).lastInsertRowid;
    students.forEach((s) => enroll.run(id, s));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) {
    console.log('Database already has users; not seeding. Delete the DB file to start fresh.');
  } else {
    seed({ db });
    console.log('Seeded. Teacher: T001 / teacher123   Students: 23BCS001..23BCS005 / student123');
  }
  db.close();
}
