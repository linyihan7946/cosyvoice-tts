const request = require('supertest');
const db = require('../db');
const { createToken } = require('../auth');

afterAll(async () => {
  await db.closeDb();
});

// Mock node-fetch 避免真实 API 调用
jest.mock('node-fetch', () => {
  return jest.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        output: {
          audio: { url: 'http://example.com/test.wav' }
        }
      }),
      text: () => Promise.resolve('{"code":"0","message":"Success"}'),
      buffer: () => Promise.resolve(Buffer.from('fake-audio-data')),
    })
  );
});

const app = require('../server');

describe('API - 认证接口', () => {
  beforeEach(async () => {
    await db.resetDb(':memory:');
  });

  describe('POST /api/auth/send-code', () => {
    test('有效手机号返回验证码', async () => {
      const res = await request(app)
        .post('/api/auth/send-code')
        .send({ phone: '13800138000' });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('debug_code');
      expect(res.body.debug_code).toMatch(/^\d{6}$/);
    });

    test('无效手机号返回 400', async () => {
      const res = await request(app)
        .post('/api/auth/send-code')
        .send({ phone: '123' });
      expect(res.status).toBe(400);
    });

    test('空手机号返回 400', async () => {
      const res = await request(app)
        .post('/api/auth/send-code')
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/auth/login', () => {
    test('缺少参数返回 400', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ phone: '13800138000' });
      expect(res.status).toBe(400);
    });

    test('错误验证码返回 400', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ phone: '13800138000', code: '000000' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('验证码');
    });
  });

  describe('GET /api/auth/me', () => {
    test('未登录返回 401', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
    });

    test('已登录返回用户信息', async () => {
      const user = await db.createUser('13800138000', '测试用户');
      const token = createToken(user.id);
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.phone).toBe('13800138000');
      expect(res.body.nickname).toBe('测试用户');
    });

    test('无效 token 返回 401', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer invalid');
      expect(res.status).toBe(401);
    });
  });
});

describe('API - 音色接口', () => {
  beforeEach(async () => {
    await db.resetDb(':memory:');
  });

  describe('GET /api/voices', () => {
    test('未登录返回内置音色', async () => {
      const res = await request(app).get('/api/voices');
      expect(res.status).toBe(200);
      expect(res.body.voices).toBeInstanceOf(Array);
      expect(res.body.voices.length).toBeGreaterThan(0);
      expect(res.body.voices.every(v => v.type === 'builtin')).toBe(true);
    });

    test('已登录返回内置 + 自定义音色', async () => {
      const user = await db.createUser('13800138000', '测试');
      await db.addCustomVoice('vc-001', user.id, 'myvoice');
      const token = createToken(user.id);
      const res = await request(app)
        .get('/api/voices')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      const custom = res.body.voices.filter(v => v.type === 'custom');
      expect(custom).toHaveLength(1);
      expect(custom[0].name).toBe('myvoice');
    });

    test('系统音色对未登录用户可见', async () => {
      await db.upsertSystemVoice('system-voice-001', '部署音色', '');
      const res = await request(app).get('/api/voices');

      expect(res.status).toBe(200);
      expect(res.body.voices).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'system-voice-001', name: '部署音色', type: 'system' }),
      ]));
    });
  });
});

describe('API - 配额接口', () => {
  beforeEach(async () => {
    await db.resetDb(':memory:');
  });

  describe('GET /api/quota', () => {
    test('未登录返回 401', async () => {
      const res = await request(app).get('/api/quota');
      expect(res.status).toBe(401);
    });

    test('已登录返回配额信息', async () => {
      const user = await db.createUser('13800138000', '测试');
      const token = createToken(user.id);
      const res = await request(app)
        .get('/api/quota')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('tier');
      expect(res.body).toHaveProperty('voiceClones');
      expect(res.body).toHaveProperty('dailyTts');
      expect(res.body.voiceClones).toHaveProperty('current');
      expect(res.body.voiceClones).toHaveProperty('limit');
    });
  });
});

describe('API - 管理员接口', () => {
  let adminToken;
  let userToken;
  let adminUser;
  let normalUser;

  beforeEach(async () => {
    await db.resetDb(':memory:');
    adminUser = await db.createUser('13800138000', '管理员');
    await db.setUserAdmin(adminUser.id, true);
    adminToken = createToken(adminUser.id);

    normalUser = await db.createUser('13900139000', '普通用户');
    userToken = createToken(normalUser.id);
  });

  describe('GET /api/auth/admin/stats', () => {
    test('管理员可以查看统计', async () => {
      const res = await request(app)
        .get('/api/auth/admin/stats')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('totalUsers');
    });

    test('普通用户无权访问返回 403', async () => {
      const res = await request(app)
        .get('/api/auth/admin/stats')
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('配额配置管理', () => {
    test('GET /api/auth/admin/quota-config 管理员获取配额', async () => {
      const res = await request(app)
        .get('/api/auth/admin/quota-config')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('free');
      expect(res.body).toHaveProperty('monthly');
      expect(res.body).toHaveProperty('admin');
    });

    test('PUT /api/auth/admin/quota-config 管理员修改配额', async () => {
      const res = await request(app)
        .put('/api/auth/admin/quota-config')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ tier: 'free', key: 'daily_tts_limit', value: 20 });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const config = await db.getQuotaConfig('free');
      expect(config.daily_tts_limit).toBe(20);
    });

    test('普通用户无法修改配额', async () => {
      const res = await request(app)
        .put('/api/auth/admin/quota-config')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ tier: 'free', key: 'daily_tts_limit', value: 999 });
      expect(res.status).toBe(403);
    });
  });

  describe('用户层级管理', () => {
    test('GET /api/auth/admin/user-tiers 管理员获取用户列表', async () => {
      const res = await request(app)
        .get('/api/auth/admin/user-tiers')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(2);
    });

    test('PUT /api/auth/admin/user-tiers 管理员修改用户层级', async () => {
      const res = await request(app)
        .put('/api/auth/admin/user-tiers')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ userId: normalUser.id, tier: 'monthly', expiresAt: '2026-12-31' });
      expect(res.status).toBe(200);

      const tier = await db.getUserTier(normalUser.id);
      expect(tier.tier).toBe('monthly');
      expect(tier.expiresAt).toBe('2026-12-31');
    });
  });

  describe('用量记录', () => {
    test('GET /api/auth/admin/usage 查询用量', async () => {
      await db.incrementTtsUsage(normalUser.id);
      await db.incrementTtsUsage(normalUser.id);
      const today = new Date().toISOString().slice(0, 10);

      const res = await request(app)
        .get(`/api/auth/admin/usage?date=${today}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const userUsage = res.body.find(r => r.userId === normalUser.id);
      expect(userUsage.ttsCount).toBe(2);
    });
  });
});

describe('API - TTS 配额检查', () => {
  beforeEach(async () => {
    await db.resetDb(':memory:');
  });

  test('超额 TTS 请求返回 429', async () => {
    const user = await db.createUser('13800138000', '测试');
    const token = createToken(user.id);

    // 默认 free 用户每天 10 次，模拟已用完
    for (let i = 0; i < 10; i++) {
      await db.incrementTtsUsage(user.id);
    }

    const res = await request(app)
      .post('/api/tts')
      .set('Authorization', `Bearer ${token}`)
      .send({ text: '测试文本', voice: 'Cherry' });

    expect(res.status).toBe(429);
    expect(res.body.error).toContain('次数已用完');
  });

  test('管理员 TTS 无限制', async () => {
    const admin = await db.createUser('13800138000', '管理员');
    await db.setUserAdmin(admin.id, true);
    const token = createToken(admin.id);

    // 管理员 daily_tts_limit = -1，不限制
    const res = await request(app)
      .post('/api/tts')
      .set('Authorization', `Bearer ${token}`)
      .send({ text: '测试文本', voice: 'Cherry' });

    // 不会返回 429（可能返回 200 或其他因为 mock）
    expect(res.status).not.toBe(429);
  });

  test('TTS 可返回微信浏览器可打开的真实音频链接', async () => {
    const user = await db.createUser('13800138000', '测试');
    const token = createToken(user.id);

    const res = await request(app)
      .post('/api/tts')
      .set('Authorization', `Bearer ${token}`)
      .send({ text: '测试文本', voice: 'Cherry', returnUrl: true });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('audioUrl');
    expect(res.body).toHaveProperty('downloadUrl');
    expect(res.body.audioUrl).toMatch(/^\/api\/tts-audio\//);

    const audioRes = await request(app).get(res.body.audioUrl);
    expect(audioRes.status).toBe(200);
    expect(audioRes.headers['content-type']).toContain('audio/wav');
  });
});

describe('API - 音色克隆配额检查', () => {
  beforeEach(async () => {
    await db.resetDb(':memory:');
  });

  test('超额克隆请求返回 429', async () => {
    const user = await db.createUser('13800138000', '测试');
    const token = createToken(user.id);

    // free 用户最多 1 个克隆
    await db.addCustomVoice('vc-001', user.id, 'existing');

    const res = await request(app)
      .post('/api/voice-clone')
      .set('Authorization', `Bearer ${token}`)
      .send({
        audioBase64: 'data:audio/wav;base64,fake',
        voiceName: 'newvoice',
        language: 'zh',
      });

    expect(res.status).toBe(429);
    expect(res.body.error).toContain('克隆上限');
  });
});

describe('API - 删除音色', () => {
  beforeEach(async () => {
    await db.resetDb(':memory:');
  });

  test('删除不存在的音色返回 404', async () => {
    const user = await db.createUser('13800138000', '测试');
    const token = createToken(user.id);

    const res = await request(app)
      .delete('/api/voice-clone/nonexistent')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  test('删除他人音色返回 403', async () => {
    const user1 = await db.createUser('13800138000', '用户1');
    const user2 = await db.createUser('13900139000', '用户2');
    await db.addCustomVoice('vc-001', user1.id, 'voice1');
    const token2 = createToken(user2.id);

    const res = await request(app)
      .delete('/api/voice-clone/vc-001')
      .set('Authorization', `Bearer ${token2}`);

    expect(res.status).toBe(403);
  });
});

describe('API - 问题反馈', () => {
  let userToken, adminToken, userId, adminId;

  beforeEach(async () => {
    await db.resetDb(':memory:');
    const user = await db.createUser('13800138000', '普通用户');
    userId = user.id;
    userToken = createToken(userId);

    const admin = await db.createUser('13900139000', '管理员');
    adminId = admin.id;
    await db.setUserAdmin(adminId, true);
    adminToken = createToken(adminId);
  });

  describe('POST /api/feedback', () => {
    test('登录用户提交反馈成功', async () => {
      const res = await request(app)
        .post('/api/feedback')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ content: '这个功能很好用', contact: '13800138000' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.feedback.content).toBe('这个功能很好用');
    });

    test('未登录提交反馈返回 401', async () => {
      const res = await request(app)
        .post('/api/feedback')
        .send({ content: '测试' });
      expect(res.status).toBe(401);
    });

    test('内容为空返回 400', async () => {
      const res = await request(app)
        .post('/api/feedback')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ content: '' });
      expect(res.status).toBe(400);
    });

    test('内容超过 2000 字返回 400', async () => {
      const res = await request(app)
        .post('/api/feedback')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ content: 'a'.repeat(2001) });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/auth/admin/feedback', () => {
    test('管理员获取反馈列表', async () => {
      await db.addFeedback(userId, '用户反馈1');
      await db.addFeedback(userId, '用户反馈2');

      const res = await request(app)
        .get('/api/auth/admin/feedback')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    test('管理员按状态筛选反馈', async () => {
      const fb1 = await db.addFeedback(userId, '待处理');
      const fb2 = await db.addFeedback(userId, '已解决');
      await db.updateFeedbackStatus(fb2.id, 'resolved');

      const res = await request(app)
        .get('/api/auth/admin/feedback?status=pending')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].content).toBe('待处理');
    });

    test('普通用户无法查看反馈返回 403', async () => {
      const res = await request(app)
        .get('/api/auth/admin/feedback')
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('PUT /api/auth/admin/feedback/:id', () => {
    test('管理员更新反馈状态', async () => {
      const fb = await db.addFeedback(userId, '测试');

      const res = await request(app)
        .put(`/api/auth/admin/feedback/${fb.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'resolved' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    test('无效状态返回 400', async () => {
      const fb = await db.addFeedback(userId, '测试');

      const res = await request(app)
        .put(`/api/auth/admin/feedback/${fb.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'invalid' });

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/auth/admin/feedback/:id', () => {
    test('管理员删除反馈', async () => {
      const fb = await db.addFeedback(userId, '要删除');

      const res = await request(app)
        .delete(`/api/auth/admin/feedback/${fb.id}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);

      const list = await db.getAllFeedback();
      expect(list).toHaveLength(0);
    });

    test('普通用户无法删除反馈返回 403', async () => {
      const fb = await db.addFeedback(userId, '测试');

      const res = await request(app)
        .delete(`/api/auth/admin/feedback/${fb.id}`)
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.status).toBe(403);
    });
  });
});
