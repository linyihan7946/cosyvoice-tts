const jwt = require('jsonwebtoken');

// JWT 密钥，从环境变量读取，开发环境有默认值
const JWT_SECRET = process.env.JWT_SECRET || 'cosyvoice-tts-jwt-secret-change-me';
const JWT_EXPIRES_IN = '30d'; // 30 天过期

/**
 * 创建 JWT Token
 */
function createToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * 验证 JWT Token，返回 userId 或 null
 */
function verifyToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded.sub || null;
  } catch (e) {
    return null;
  }
}

/**
 * Express 认证中间件
 * 从 Authorization: Bearer <token> 提取并验证 JWT
 * 验证通过后将 userId 注入 req.userId
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '请先登录' });
  }

  const token = authHeader.slice(7);
  const userId = verifyToken(token);
  if (!userId) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }

  req.userId = userId;
  next();
}

/**
 * 可选认证中间件
 * 如果提供了有效的 JWT 则注入 userId，否则继续但不设置 userId
 */
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const userId = verifyToken(token);
    if (userId) {
      req.userId = userId;
    }
  }
  next();
}

module.exports = {
  createToken,
  verifyToken,
  authMiddleware,
  optionalAuth,
};
