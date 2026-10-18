import './env-fresh.js';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import { keyGuessLimiter } from '../src/middleware/security.js';

/**
 * Guessing API keys hits a wall: ten refused keys from one address and the
 * rest of the window is 429 - while requests with a working key never count.
 */
test('ten refused keys and the address is stopped; working ones never count', async () => {
  const app = express();
  app.use(keyGuessLimiter(true));
  app.get('/x', (req, res) => {
    res.status(req.get('authorization') === 'Bearer good' ? 200 : 401).send('');
  });

  for (let i = 0; i < 20; i++) await request(app).get('/x').set('Authorization', 'Bearer good').expect(200);
  for (let i = 0; i < 10; i++) await request(app).get('/x').set('Authorization', 'Bearer guess' + i).expect(401);
  await request(app).get('/x').set('Authorization', 'Bearer guess-11').expect(429);
  // Once stopped, a right key from that address waits out the window too.
  await request(app).get('/x').set('Authorization', 'Bearer good').expect(429);
});
