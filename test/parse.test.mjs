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

test('备注保留用户说的那样东西，不因为「正好是个分类词」就丢掉', () => {
  // 原来这几条断言的是空字符串：分类关键词命中了就从备注里抠掉。
  // 结果是一整句话说完，流水页上只剩「2026-11-11 200.00元」——
  // 用户明明说了「交电费」，却看不出这笔是什么。分类已经单独有一栏了，
  // 备注该保留原话。
  assert.equal(parseEntry('交电费200', ctx).note, '交电费');
  assert.equal(parseEntry('今天买菜35.5元', ctx).note, '买菜');
  assert.equal(parseEntry('今天话费50元', ctx).note, '话费');
  // 「孩子」是成员别名，会被认成成员并从备注里摘掉——这里摘对了
  assert.equal(parseEntry('给孩子买衣服 260', ctx).note, '买衣服');
  assert.equal(parseEntry('给孩子买衣服 260', ctx).memberName, '小明');
  const withAcc = { ...ctx, accounts: DEFAULT_ACCOUNTS }; // 带账户配置时「微信」会被当作支付方式摘掉
  assert.equal(parseEntry('午饭 25 微信', withAcc).note, '午饭');
});

test('付款方式不算备注，但说了也不影响其他字段', () => {
  // DEFAULT_ACCOUNTS 没有 id，这里补上，模拟从数据库读回来的账户
  const accounts = DEFAULT_ACCOUNTS.map((a, i) => ({ ...a, id: `acc-${i}` }));
  const withAcc = { ...ctx, accounts };
  const withWechat = parseEntry('今天买菜35.5元 微信', withAcc);
  const without = parseEntry('今天买菜35.5元', withAcc);
  assert.equal(withWechat.note, '买菜', '「微信」不该进备注');
  assert.equal(withWechat.fromAccountId, 'acc-1', '「微信」该被认成付款账户');
  assert.equal(without.fromAccountId, null, '没说付款方式就不该有账户');
  assert.equal(withWechat.amount, without.amount, '付款方式改了金额');
  assert.equal(withWechat.categoryId, without.categoryId, '付款方式改了分类');
  assert.equal(withWechat.kind, without.kind, '付款方式改了收支类型');
});

test('日常账单能自动落到二级分类', () => {
  assert.equal(parseEntry('超市 158', ctx).categoryFullName, '购物/日用百货');
  assert.equal(parseEntry('早点12块', ctx).categoryFullName, '餐饮/在外吃饭');
  assert.equal(parseEntry('交电费200', ctx).categoryFullName, '居住/水电燃气');
  assert.equal(parseEntry('充话费100', ctx).categoryFullName, '通讯/话费流量');
  assert.equal(parseEntry('昨天加油300', ctx).categoryFullName, '交通/车辆费用');
});

test('自己加的分类，和默认分类的关键词撞了也要能命中', () => {
  // 默认的「在外吃饭」本来就把「奶茶」当关键词。用户又加了一个名叫「奶茶」的分类。
  // 两边都是 2 字、都是小类 → 得分完全相同。原来的实现是「先遍历到谁就是谁」，
  // 于是用户新建的分类永远轮不到——加进去等于白加，界面里还看不出为什么。
  const cats = [
    ...flattenCategories(),
    {
      id: 'my-milktea',
      name: '奶茶',
      kind: 'expense',
      parent_id: 'food',
      fullName: '餐饮/奶茶',
      keywords: ['奶茶', '喜茶', '珍珠'],
    },
  ];
  const mine = { ...ctx, categories: cats };
  const hit = parseEntry('今天买奶茶18元', mine);
  assert.equal(hit.categoryId, 'my-milktea', '自己加的分类没被用上');
  assert.equal(hit.categoryFullName, '餐饮/奶茶');
  // 顺带确认别的东西没被带偏
  assert.equal(hit.amount, 18, '分类命中改了金额');
  // 备注跟「今天买菜35.5元」→「买菜」同一个规矩：原话里除了日期、金额、分类词之外
  // 的都留着，剩下的比抠掉分类词更多就用剩下的
  assert.equal(hit.note, '买奶茶', '分类命中把备注吃掉了');

  // 只用自己加的分类里独有的关键词，同样要能命中
  assert.equal(parseEntry('今天买喜茶18元', mine).categoryId, 'my-milktea');

  // 不撞名的默认关键词不受影响：没有自定义分类时「奶茶」仍归「在外吃饭」
  assert.equal(parseEntry('今天买奶茶18元', ctx).categoryFullName, '餐饮/在外吃饭');
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
