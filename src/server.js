const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { APIBridgeDiamondService } = require('./services/apibridgediamond-service');

class Server {
    constructor(port = 3000, options = {}) {
        this.port = Number(port); this.app = express(); this.service = options.service || new APIBridgeDiamondService(options); this.httpServer = null;
        this.app.disable('x-powered-by'); this.app.use(cors()); if (options.logging !== false) this.app.use(morgan('dev')); this.app.use(express.json({ limit: '1mb' })); this.routes();
    }
    routes() {
        this.app.get('/health', async (q, r, n) => { try { r.json({ status: 'healthy', service: 'APIBridgeDiamond', ...(await this.service.metrics()) }); } catch (e) { n(e); } });
        this.app.get('/v1/routes', async (q, r, n) => { try { r.json({ routes: await this.service.listRoutes() }); } catch (e) { n(e); } });
        this.app.post('/v1/routes', async (q, r, n) => { try { r.status(201).json(await this.service.createRoute(q.body)); } catch (e) { n(e); } });
        this.app.delete('/v1/routes/:name', async (q, r, n) => { try { const removed = await this.service.removeRoute(q.params.name); r.status(removed ? 204 : 404).end(); } catch (e) { n(e); } });
        this.app.post('/v1/routes/:name/events', async (q, r, n) => { try { const delivery = await this.service.enqueue(q.params.name, q.body, { idempotencyKey: q.get('idempotency-key') }); r.status(202).location(`/v1/deliveries/${delivery.id}`).json(delivery); } catch (e) { n(e); } });
        this.app.get('/v1/deliveries', async (q, r, n) => { try { r.json({ deliveries: await this.service.listDeliveries() }); } catch (e) { n(e); } });
        this.app.get('/v1/deliveries/:id', async (q, r, n) => { try { const item = await this.service.getDelivery(q.params.id); item ? r.json(item) : r.status(404).json({ error: 'Delivery not found' }); } catch (e) { n(e); } });
        this.app.use((q, r) => r.status(404).json({ error: 'Route not found' }));
        this.app.use((e, q, r, n) => r.status(e.statusCode || 500).json({ error: e.message }));
    }
    async start() { await this.service.init(); return new Promise((resolve, reject) => { this.httpServer = this.app.listen(this.port).once('error', reject).once('listening', () => resolve(this.httpServer)); }); }
    stop() { return this.httpServer ? new Promise((resolve, reject) => this.httpServer.close(e => e ? reject(e) : resolve())) : Promise.resolve(); }
}
if (require.main === module) new Server(process.env.PORT || 3000, { dataFile: process.env.DATA_FILE }).start().then(server => console.log(`APIBridgeDiamond listening on port ${server.address().port}`)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { Server };
