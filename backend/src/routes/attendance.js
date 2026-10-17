import { HttpError } from '../errors.js';
import {
  startAttempt, submitBle, submitQr, startLiveness, submitLiveness, completeAttempt, loadAttempt, attemptView,
} from '../services/attendance.js';

/**
 * Student attendance flow (maps 1:1 onto the frontend pages):
 *   Dashboard "Mark Attendance"  -> POST /api/attendance/attempts
 *   BleVerification page         -> POST /api/attendance/attempts/:id/ble
 *   (optional QR scan)           -> POST /api/attendance/attempts/:id/qr
 *   FaceLiveness page            -> POST .../liveness/challenge, then POST .../liveness
 *   AttendanceSuccess page       -> POST /api/attendance/attempts/:id/complete
 */
export function registerAttendanceRoutes(r, app) {
  const student = { roles: ['student'] };

  r.post('/api/attendance/attempts', ({ user, body }) => {
    if (!body.sessionCode && body.courseId == null) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Provide `courseId` or `sessionCode`.');
    }
    return { status: 201, body: startAttempt(app, user, body) };
  }, student);

  r.get('/api/attendance/attempts/:id', ({ user, params }) => {
    const { a, session } = loadAttempt(app, user, params.id);
    return attemptView(app, a, session);
  }, student);

  r.post('/api/attendance/attempts/:id/ble', ({ user, params, body }) => submitBle(app, user, params.id, body), student);
  r.post('/api/attendance/attempts/:id/qr', ({ user, params, body }) => submitQr(app, user, params.id, body), student);
  r.post('/api/attendance/attempts/:id/liveness/challenge', ({ user, params }) => startLiveness(app, user, params.id), student);
  r.post('/api/attendance/attempts/:id/liveness', ({ user, params, body }) => submitLiveness(app, user, params.id, body), student);
  r.post('/api/attendance/attempts/:id/complete', ({ user, params }) => completeAttempt(app, user, params.id), student);
}
