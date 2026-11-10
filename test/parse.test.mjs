import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEntry, cnToNumber, extractAmount, extractDate } from '../src/parse.js';
import { DEFAULT_CATEGORIES, DEFAULT_ACCOUNTS } from '../src/defaults.js';

/** 把 defaults 里的树拍平成数据库里的行结构，模拟线上数据结构 */
function flattenCategories() {
  const rows = [];
  for (const parent of DEFAULT_CATEGORIES) {
    rows.push({
      id: parent.key,
      name: parent.name,
      kind: parent.kind,
      parent_id: null,
      fullName: parent.name,
      keywords: parent.keywords || [],
    });
    for (const child of parent.children || []) {
      rows.push({
        id: child.key,
        name: child.name,
        kind: parent.kind,
        parent_id: parent.key,
        fullName: `${parent.name}/${child.name}`,
        keywords: child.keywords || [],
      });
    }
  }
  return rows;
}

const ctx = {
  today: '2026-11-11',
  members: [
    { id: 'm-dad', display_name: '爸爸', role: 'father' },
    { id: 'm-mom', display_name: '妈妈', role: 'mother' },
    { id: 'm-kid', display_name: '小明', role: 'child' },
  ],
  categories: flattenCategories(),
};

test('中文数字转换', () => {
  assert.equal(cnToNumber('三十'), 30);
  assert.equal(cnToNumber('一百五'), 150);
  assert.equal(cnToNumber('三千'), 3000);
  assert.equal(cnToNumber('一万二'), 12000);
  // 下面这几条曾经都算错：百位后面跟十位会被当成「省略写法」
  assert.equal(cnToNumber('二百六十八'), 268);
  assert.equal(cnToNumber('两百三十五'), 235);
  assert.equal(cnToNumber('三百五'), 350);
  assert.equal(cnToNumber('一千零五'), 1005);
  assert.equal(cnToNumber('两万三'), 23000);
});

test('金额提取：带单位优先，跳过日期数字', () => {
  assert.equal(extractAmount('花了35.5元').value, 35.5);
  assert.equal(extractAmount('1.5万').value, 15000);
  assert.equal(extractAmount('3000块').value, 3000);
  assert.equal(extractAmount('没有数字'), null);
});

test('日期提取：相对日期与月日', () => {
  assert.equal(extractDate('今天买菜', '2026-11-11').date, '2026-11-11');
  assert.equal(extractDate('昨天买菜', '2026-11-11').date, '2026-11-10');
  assert.equal(extractDate('11月8日买菜', '2026-11-11').date, '2026-11-08');
  assert.equal(extractDate('2026年3月2日买菜', '2026-11-11').date, '2026-03-02');
  // 跨年补录：今天 11 月，说 12 月的账，应归到去年
  assert.equal(extractDate('12月20日买菜', '2026-11-11').date, '2025-12-20');
});

test('场景1：11月8日购买牛奶花了35.5元', () => {
  const r = parseEntry('11月8日购买牛奶花了35.5元', ctx);
  assert.equal(r.amount, 35.5);
  assert.equal(r.occurredOn, '2026-11-08');
  assert.equal(r.kind, 'expense');
  assert.ok(['shopping', 'shopping-daily'].includes(r.categoryId), `实际归类：${r.categoryId}`);
  assert.match(r.note, /牛奶/);
});

test('场景2：今天给孩子报了补习班花了3000', () => {
  const r = parseEntry('今天给孩子报了补习班花了3000', ctx);
  assert.equal(r.amount, 3000);
  assert.equal(r.occurredOn, '2026-11-11');
  assert.equal(r.categoryId, 'education-training');
  assert.equal(r.memberId, 'm-kid');
});

test('场景3：收到工资8000元 → 收入', () => {
  const r = parseEntry('收到工资8000元', ctx);
  assert.equal(r.kind, 'income');
  assert.equal(r.amount, 8000);
  assert.equal(r.categoryId, 'salary');
});

test('场景4：发奖金2000 → 收入/奖金', () => {
  const r = parseEntry('发奖金2000', ctx);
  assert.equal(r.kind, 'income');
  assert.equal(r.amount, 2000);
  assert.equal(r.categoryId, 'bonus');
});

test('场景5：转账不计入收支', () => {
  const r = parseEntry('从银行卡转账500到微信', ctx);
  assert.equal(r.kind, 'transfer');
  assert.equal(r.amount, 500);
  assert.equal(r.categoryId, null);
});

test('场景6：借给别人钱不计入支出', () => {
  const r = parseEntry('借给老王1000元', ctx);
  assert.equal(r.kind, 'lend');
  assert.equal(r.amount, 1000);
});

test('场景7：报销回款不计入收入', () => {
  const r = parseEntry('报销回来200元', ctx);
  assert.equal(r.kind, 'reimburse_back');
  assert.equal(r.amount, 200);
});

test('场景8：垫付要标记可报销', () => {
  const r = parseEntry('先垫付打车费60元', ctx);
  assert.equal(r.kind, 'expense');
  assert.equal(r.reimbursable, true);
  assert.equal(r.categoryId, 'traffic-taxi');
});

test('场景9：中文数字金额', () => {
  const r = parseEntry('昨天买菜三十五块', ctx);
  assert.equal(r.amount, 35);
  assert.equal(r.occurredOn, '2026-11-10');
  assert.equal(r.categoryId, 'food-market');
});

test('场景10：房贷/电费归到居住', () => {
  assert.equal(parseEntry('交电费180元', ctx).categoryId, 'housing-utility');
  assert.equal(parseEntry('还房贷5000', ctx).categoryId, 'housing-rent');
});

test('场景11：会员按人识别——爸爸的工资', () => {
  const r = parseEntry('爸爸收到工资12000元', ctx);
  assert.equal(r.memberId, 'm-dad');
  assert.equal(r.kind, 'income');
  assert.equal(r.amount, 12000);
});

test('场景12：无金额时应给出提示而不是崩溃', () => {
  const r = parseEntry('今天心情不错', ctx);
  assert.equal(r.amount, null);
  assert.equal(r.ok, false);
  assert.ok(r.warnings.length > 0);
});

test('场景13：空输入不崩溃', () => {
  const r = parseEntry('   ', ctx);
  assert.equal(r.ok, false);
  assert.equal(r.amount, null);
});

/* ---- 一批「家里人真会说的话」回归：下面这些句子都曾经认错 ---- */

test('借还款方向：还我 = 收回借款，我还 = 归还借款', () => {
  assert.equal(parseEntry('妈妈还我200', ctx).kind, 'lend_return');
  assert.equal(parseEntry('我还妈妈150', ctx).kind, 'borrow_return');
  assert.equal(parseEntry('收回借出的1000', ctx).kind, 'lend_return');
  assert.equal(parseEntry('借给妈妈500', ctx).kind, 'lend');
  assert.equal(parseEntry('向爸爸借了300', ctx).kind, 'borrow');
});

test('账户之间挪钱不算支出：转账与取现', () => {
  assert.equal(parseEntry('银行卡转支付宝 1000', ctx).kind, 'transfer');
  assert.equal(parseEntry('从银行卡取500现金', ctx).kind, 'transfer');
});

test('口语日期：上周三 / 这周一 / 9.5号', () => {
  assert.equal(parseEntry('上周三交物业费280', ctx).occurredOn, '2026-11-04');
  assert.equal(parseEntry('这周一买菜30', ctx).occurredOn, '2026-11-09');
  assert.equal(parseEntry('9.5号 早餐 12', ctx).occurredOn, '2026-09-05');
});

test('上月8号 / 上上个月5号：补录到正确的月份', () => {
  assert.equal(parseEntry('上月8号交电费200', ctx).occurredOn, '2026-10-08');
  assert.equal(parseEntry('上个月31号交电费200', ctx).occurredOn, '2026-10-31');
  assert.equal(parseEntry('上上个月5号交电费200', ctx).occurredOn, '2026-09-05');
  // 上个月只有 30 天时，31 号要夹到月末，不能滚到下个月
  const dec = { ...ctx, today: '2026-12-05' };
  assert.equal(parseEntry('上月31号交电费200', dec).occurredOn, '2026-11-30');
});

test('备注不会只剩半个词', () => {
  assert.equal(parseEntry('交电费200', ctx).note, '');
  assert.equal(parseEntry('给孩子买衣服 260', ctx).note, '');
  const withAcc = { ...ctx, accounts: DEFAULT_ACCOUNTS }; // 带账户配置时「微信」会被当作支付方式摘掉
  assert.equal(parseEntry('午饭 25 微信', withAcc).note, '午饭');
  assert.equal(parseEntry('给小明买书 45', ctx).note, '买书');
});

test('日常账单能自动落到二级分类', () => {
  assert.equal(parseEntry('超市 158', ctx).categoryFullName, '购物/日用百货');
  assert.equal(parseEntry('早点12块', ctx).categoryFullName, '餐饮/在外吃饭');
  assert.equal(parseEntry('交电费200', ctx).categoryFullName, '居住/水电燃气');
  assert.equal(parseEntry('充话费100', ctx).categoryFullName, '通讯/话费流量');
  assert.equal(parseEntry('昨天加油300', ctx).categoryFullName, '交通/车辆费用');
});

test('「还钱」不知道谁还谁时要提示核对，而不是默默猜', () => {
  const r = parseEntry('朋友还钱 2000', ctx);
  assert.ok(r.warnings.some((w) => w.includes('谁还谁')), r.warnings.join(' | '));
});

/* ---- 语音输入：说出来常常是中文数字、没标点、带空格 ---- */

test('语音里不带「元/块」的中文数字也认', () => {
  assert.equal(parseEntry('昨天 加油 三百', ctx).amount, 300);
  assert.equal(parseEntry('给娃 交了 学费 八千', ctx).amount, 8000);
  assert.equal(parseEntry('一共两百', ctx).amount, 200);
  assert.equal(parseEntry('花了 三百五', ctx).amount, 350);
});

test('量词里的数字不算金额（两个人、十分钟、一斤苹果）', () => {
  assert.equal(parseEntry('等了 十分钟', ctx).amount, null);
  assert.equal(parseEntry('两个人 吃饭', ctx).amount, null);
  assert.equal(parseEntry('买了一斤苹果', ctx).amount, null);
});

test('口语小数：35块5 是 35.5，不是 35', () => {
  assert.equal(parseEntry('打车 三十八块五', ctx).amount, 38.5);
  assert.equal(parseEntry('买菜三十五块五毛', ctx).amount, 35.5);
  assert.equal(parseEntry('妈妈 买的 水果 四十二块八', ctx).amount, 42.8);
  assert.equal(parseEntry('买了个电饭锅 199 块6', ctx).amount, 199.6);
});

test('说「一万二」是一万二，不是一万零二', () => {
  const r = parseEntry('工资 一万二', ctx);
  assert.equal(r.amount, 12000);
  assert.equal(r.kind, 'income');
});

test('单字分类词不会撞进别的词里', () => {
  // 「电饭锅」里的「饭」不该被当成餐饮
  assert.equal(parseEntry('买了个电饭锅 199 块', ctx).categoryFullName, '购物/数码家电');
  // 但「午饭」里的「饭」在词尾，仍然算餐饮
  assert.equal(parseEntry('午饭 25', ctx).categoryName, '餐饮');
});
