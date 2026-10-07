const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const request = require('supertest');
const { Server } = require('../src/server');
const { APIBridgeDiamondService } = require('../src/services/apibridgediamond-service');

describe('APIBridgeDiamond', () => {
    let directory;
    let calls;
    let fetch;
    let service;
    let server;

    beforeEach(async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'apibridge-'));
        calls = [];
        fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 204 }; };
        service = await new APIBridgeDiamondService({ dataFile: path.join(directory, 'state.json'), fetch }).init();
        server = new Server(0, { service, logging: false });
    });
    afterEach(async () => fs.rm(directory, { recursive: true, force: true }));

    test('creates a route without exposing its signing secret', async () => {
        const response = await request(server.app).post('/v1/routes').send({ name: 'orders', targetUrl: 'https://example.test/hooks', secret: 'sign-me' }).expect(201);
        assert.equal(response.body.name, 'orders');
        assert.equal(response.body.signed, true);
        assert.equal(response.body.secret, undefined);
    });

    test('queues and delivers a signed event', async () => {
        await service.createRoute({ name: 'orders', targetUrl: 'https://example.test/hooks', secret: 'sign-me' });
        const response = await request(server.app).post('/v1/routes/orders/events').send({ orderId: 42 }).expect(202);
        const delivery = await waitFor(service, response.body.id);
        assert.equal(delivery.status, 'delivered');
        assert.equal(calls.length, 1);
        const expected = `sha256=${crypto.createHmac('sha256', 'sign-me').update(calls[0].options.body).digest('hex')}`;
        assert.equal(calls[0].options.headers['x-api-bridge-signature-256'], expected);
    });

    test('deduplicates repeated idempotency keys', async () => {
        await service.createRoute({ name: 'orders', targetUrl: 'https://example.test/hooks' });
        const first = await request(server.app).post('/v1/routes/orders/events').set('Idempotency-Key', 'same').send({ value: 1 }).expect(202);
        const second = await request(server.app).post('/v1/routes/orders/events').set('Idempotency-Key', 'same').send({ value: 1 }).expect(202);
        assert.equal(second.body.id, first.body.id);
        await waitFor(service, first.body.id);
        assert.equal(calls.length, 1);
    });

    test('retries and records terminal delivery failures', async () => {
        service.fetch = async () => ({ ok: false, status: 503 });
        await service.createRoute({ name: 'orders', targetUrl: 'https://example.test/hooks' });
        const delivery = await service.enqueue('orders', { value: 1 });
        const result = await waitFor(service, delivery.id);
        assert.equal(result.status, 'failed');
        assert.equal(result.attempts, 3);
        assert.equal(result.responseStatus, 503);
    });

    test('persists routes and delivery history', async () => {
        await service.createRoute({ name: 'orders', targetUrl: 'https://example.test/hooks' });
        const delivery = await service.enqueue('orders', { value: 1 });
        await waitFor(service, delivery.id);
        const restored = await new APIBridgeDiamondService({ dataFile: service.dataFile, fetch }).init();
        assert.equal((await restored.listRoutes()).length, 1);
        assert.equal((await restored.listDeliveries()).length, 1);
    });

    test('validates routes and reports health metrics', async () => {
        await request(server.app).post('/v1/routes').send({ name: 'Bad Name', targetUrl: 'file:///tmp/no' }).expect(400);
        await request(server.app).post('/v1/routes/missing/events').send({ value: 1 }).expect(404);
        const health = await request(server.app).get('/health').expect(200);
        assert.equal(health.body.status, 'healthy');
        assert.equal(health.body.routes, 0);
    });
});

async function waitFor(service, id) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const delivery = await service.getDelivery(id);
        if (['delivered', 'failed'].includes(delivery.status)) return delivery;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Delivery did not finish');
}
