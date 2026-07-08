const jwt = require('jsonwebtoken');
const { createToken, verifyToken, authMiddleware, optionalAuth } = require('../auth');

const JWT_SECRET = process.env.JWT_SECRET || 'cosyvoice-tts-jwt-secret-change-me';

describe('Auth - createToken', () => {
  test('生成有效 token', () => {
    const token = createToken('user-123');
    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);
  });

  test('token 包含正确的 userId', () => {
    const token = createToken('user-456');
    const decoded = jwt.verify(token, JWT_SECRET);
    expect(decoded.sub).toBe('user-456');
  });
});

describe('Auth - verifyToken', () => {
  test('验证有效 token 返回 userId', () => {
    const token = createToken('user-789');
    const userId = verifyToken(token);
    expect(userId).toBe('user-789');
  });

  test('验证无效 token 返回 null', () => {
    const userId = verifyToken('invalid-token');
    expect(userId).toBeNull();
  });

  test('验证过期 token 返回 null', () => {
    // 创建一个已过期的 token
    const expiredToken = jwt.sign({ sub: 'user-expired' }, JWT_SECRET, { expiresIn: '-1s' });
    const userId = verifyToken(expiredToken);
    expect(userId).toBeNull();
  });

  test('验证空 token 返回 null', () => {
    const userId = verifyToken('');
    expect(userId).toBeNull();
  });

  test('验证 null 返回 null', () => {
    const userId = verifyToken(null);
    expect(userId).toBeNull();
  });
});

describe('Auth - authMiddleware', () => {
  const mockNext = jest.fn();

  const createMockRes = () => {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    return res;
  };

  beforeEach(() => {
    mockNext.mockClear();
  });

  test('无 Authorization header 返回 401', () => {
    const req = { headers: {} };
    const res = createMockRes();
    authMiddleware(req, res, mockNext);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: '请先登录' });
    expect(mockNext).not.toHaveBeenCalled();
  });

  test('无效 Authorization 格式返回 401', () => {
    const req = { headers: { authorization: 'Basic xxx' } };
    const res = createMockRes();
    authMiddleware(req, res, mockNext);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  test('无效 token 返回 401', () => {
    const req = { headers: { authorization: 'Bearer invalid-token' } };
    const res = createMockRes();
    authMiddleware(req, res, mockNext);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: '登录已过期，请重新登录' });
    expect(mockNext).not.toHaveBeenCalled();
  });

  test('有效 token 注入 userId 并调用 next', () => {
    const token = createToken('user-test');
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = createMockRes();
    authMiddleware(req, res, mockNext);
    expect(req.userId).toBe('user-test');
    expect(mockNext).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('Auth - optionalAuth', () => {
  const mockNext = jest.fn();

  beforeEach(() => {
    mockNext.mockClear();
  });

  test('无 Authorization header 继续执行', () => {
    const req = { headers: {} };
    const res = {};
    optionalAuth(req, res, mockNext);
    expect(req.userId).toBeUndefined();
    expect(mockNext).toHaveBeenCalled();
  });

  test('无效 token 继续执行但不注入 userId', () => {
    const req = { headers: { authorization: 'Bearer invalid' } };
    const res = {};
    optionalAuth(req, res, mockNext);
    expect(req.userId).toBeUndefined();
    expect(mockNext).toHaveBeenCalled();
  });

  test('有效 token 注入 userId 并继续执行', () => {
    const token = createToken('user-optional');
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = {};
    optionalAuth(req, res, mockNext);
    expect(req.userId).toBe('user-optional');
    expect(mockNext).toHaveBeenCalled();
  });
});
