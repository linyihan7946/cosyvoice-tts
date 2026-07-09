/**
 * 批量克隆系统音色脚本
 * 读取指定目录下的所有 WAV 文件，通过管理员 API 克隆为系统音色
 */
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const VOICE_DIR = process.env.VOICE_DIR || 'E:/视频创作/新增声音';
const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

if (!ADMIN_TOKEN) {
  console.error('❌ 请设置环境变量 ADMIN_TOKEN（管理员 JWT token）');
  process.exit(1);
}

async function cloneVoice(filePath, voiceName) {
  const ext = path.extname(filePath).toLowerCase();
  console.log(`\n🎙️  正在克隆: ${voiceName} (${path.basename(filePath)})`);

  try {
    const response = await fetch(`${API_BASE}/api/auth/admin/clone-system-voice`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({
        audioFilePath: filePath,
        voiceName: voiceName,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error(`  ❌ 失败: ${data.error || response.statusText}`);
      if (data.detail) console.error(`     详情: ${JSON.stringify(data.detail)}`);
      return { success: false, name: voiceName, error: data.error };
    }

    console.log(`  ✅ 成功: ${voiceName} → ${data.voice?.id}`);
    return { success: true, name: voiceName, voiceId: data.voice?.id };
  } catch (e) {
    console.error(`  ❌ 异常: ${e.message}`);
    return { success: false, name: voiceName, error: e.message };
  }
}

async function main() {
  console.log('📁 扫描目录:', VOICE_DIR);

  if (!fs.existsSync(VOICE_DIR)) {
    console.error(`❌ 目录不存在: ${VOICE_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(VOICE_DIR)
    .filter(f => /\.(wav|mp3|m4a|flac|ogg)$/i.test(f));

  if (files.length === 0) {
    console.log('⚠️  未找到音频文件');
    process.exit(0);
  }

  console.log(`📊 找到 ${files.length} 个音频文件:\n`);
  files.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  console.log('');

  const results = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const filePath = path.join(VOICE_DIR, file);
    const voiceName = path.basename(file, path.extname(file));

    console.log(`\n[${i + 1}/${files.length}]`);
    const result = await cloneVoice(filePath, voiceName);
    results.push(result);

    // 防止 API 限流，间隔 2 秒
    if (i < files.length - 1) {
      console.log('  ⏳ 等待 2 秒...');
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // 汇总
  console.log('\n' + '='.repeat(50));
  console.log('📊 克隆结果汇总:');
  console.log('='.repeat(50));

  const success = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log(`✅ 成功: ${success.length}/${results.length}`);
  success.forEach(r => console.log(`  • ${r.name} → ${r.voiceId}`));

  if (failed.length > 0) {
    console.log(`\n❌ 失败: ${failed.length}/${results.length}`);
    failed.forEach(r => console.log(`  • ${r.name}: ${r.error}`));
  }
}

main().catch(e => {
  console.error('脚本执行失败:', e);
  process.exit(1);
});
