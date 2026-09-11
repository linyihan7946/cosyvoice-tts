describe('服务配置', () => {
  const originalPort = process.env.PORT;

  afterEach(() => {
    jest.resetModules();
    if (originalPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = originalPort;
    }
  });

  test('未指定 PORT 时使用 3000', () => {
    delete process.env.PORT;
    const app = require('../server');
    expect(app.locals.port).toBe(3000);
  });

  test('使用 PORT 环境变量指定监听端口', () => {
    process.env.PORT = '3001';
    const app = require('../server');
    expect(app.locals.port).toBe(3001);
  });
});
