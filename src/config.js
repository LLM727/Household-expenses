/**
 * 运行配置。
 *
 * SUPABASE_URL / SUPABASE_ANON_KEY 从 Supabase 控制台获取：
 *   项目首页 → 右上角「Connect」或 Settings → API
 *   复制 Project URL 和 anon public key 填到下面，然后提交推送即可生效。
 *
 * 关于安全：anon key 是设计上公开的前端密钥，写在仓库里没有问题。
 * 真正的隔离靠数据库里的行级权限（见 supabase/schema.sql），
 * 别人拿到这个 key 也读不到你家的数据。
 *
 * 如果两项留空，应用会进入「本机演示模式」：数据只存在这台设备的浏览器里，
 * 可以先完整体验功能，不会上传任何东西。
 */

export const CONFIG = {
  appName: '家庭记账本',
  supabaseUrl: '',
  supabaseAnonKey: '',
  /** 默认货币符号 */
  currency: '¥',
  /** 提醒阈值：预算使用率达到多少算「快超支」 */
  budgetWarnRatio: 0.8,
};

export function isConfigured(cfg = CONFIG) {
  return Boolean(cfg.supabaseUrl && cfg.supabaseAnonKey);
}
