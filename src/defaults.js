/**
 * 内置默认数据：成员角色、收支类型、默认分类（两级：大类 -> 小类）
 * 分类可扩展：数据库里 categories 表会以 family_id = null 存系统内置项，
 * 家庭自加的条目用 family_id = <本家庭> 保存。
 */

/** 家庭成员角色 —— 对应你要求的「父、母、孩子」 */
export const ROLES = [
  { key: 'father', name: '爸爸', aliases: ['爸爸', '爸', '父亲', '老爸', '父'] },
  { key: 'mother', name: '妈妈', aliases: ['妈妈', '妈', '母亲', '老妈', '母'] },
  { key: 'child', name: '孩子', aliases: ['孩子', '儿子', '女儿', '娃', '宝宝', '闺女', '小子', '小孩'] },
  { key: 'other', name: '其他', aliases: ['其他', '家人', '老人', '爷爷', '奶奶', '外公', '外婆'] },
];

/**
 * 收支类型。
 * counted = true 表示计入家庭收支合计；false 表示只影响账户余额/债权债务，不计入合计。
 * 依据：转账、借还款不计入（否则钱在自己口袋之间挪动会被算成一次收入+一次支出）。
 */
export const KINDS = [
  { key: 'expense', name: '支出', counted: true, sign: -1, group: 'normal' },
  { key: 'income', name: '收入', counted: true, sign: 1, group: 'normal' },
  { key: 'transfer', name: '转账', counted: false, group: 'special' },
  { key: 'lend', name: '借出', counted: false, group: 'special' },
  { key: 'lend_return', name: '收回借款', counted: false, group: 'special' },
  { key: 'borrow', name: '借入', counted: false, group: 'special' },
  { key: 'borrow_return', name: '归还借款', counted: false, group: 'special' },
  { key: 'reimburse_back', name: '报销回款', counted: false, group: 'special', offsetExpense: true },
];

export const KIND_MAP = Object.fromEntries(KINDS.map((k) => [k.key, k]));

/** 默认账户 */
export const DEFAULT_ACCOUNTS = [
  { name: '现金', kind: 'cash' },
  { name: '微信', kind: 'wallet' },
  { name: '支付宝', kind: 'wallet' },
  { name: '银行卡', kind: 'bank' },
];

/**
 * 默认分类。keywords 用于语音/文字自动分类。
 * 大类 keywords 也参与匹配，小类命中优先。
 */
export const DEFAULT_CATEGORIES = [
  {
    key: 'food', name: '餐饮', kind: 'expense', icon: '🍚',
    keywords: ['吃饭', '吃', '餐', '饭'],
    children: [
      { key: 'food-market', name: '买菜', keywords: ['买菜', '菜市场', '买菜做饭', '蔬菜', '水果', '猪肉', '排骨', '鸡蛋', '生鲜', '肉'] },
      { key: 'food-out', name: '在外吃饭', keywords: ['外卖', '饭店', '餐厅', '火锅', '烧烤', '聚餐', '食堂', '咖啡', '奶茶', '早餐店', '面馆', '请客', '早点', '早饭', '早餐', '夜宵'] },
      { key: 'food-snack', name: '零食饮料', keywords: ['零食', '饮料', '薯片', '巧克力', '冰淇淋', '雪糕', '蛋糕', '面包'] },
    ],
  },
  {
    key: 'traffic', name: '交通', kind: 'expense', icon: '🚗',
    keywords: ['出行', '路费'],
    children: [
      { key: 'traffic-taxi', name: '打车', keywords: ['打车', '出租车', '网约车', '滴滴', '的士'] },
      { key: 'traffic-public', name: '公共交通', keywords: ['地铁', '公交', '公交卡', '高铁', '火车', '动车', '车票', '机票', '飞机', '船票'] },
      { key: 'traffic-car', name: '车辆费用', keywords: ['加油', '油费', '汽油', '停车', '停车费', '洗车', '保养', '过路费', '高速费', '违章', '保险'] },
    ],
  },
  {
    key: 'shopping', name: '购物', kind: 'expense', icon: '🛒',
    keywords: ['买', '购'],
    children: [
      { key: 'shopping-daily', name: '日用百货', keywords: ['日用品', '纸巾', '洗衣液', '牙膏', '毛巾', '垃圾袋', '洗发水', '沐浴露', '清洁', '超市', '化妆品', '护肤品', '洗面奶'] },
      { key: 'shopping-clothes', name: '服饰鞋帽', keywords: ['衣服', '鞋', '裤子', '裙子', '外套', '内衣', '袜子', '帽子', '包包'] },
      { key: 'shopping-digital', name: '数码家电', keywords: ['手机', '电脑', '家电', '冰箱', '洗衣机', '空调', '耳机', '相机', '电视', '充电器', '电饭锅', '微波炉', '电风扇', '热水器', '显示器', '键盘', '鼠标'] },
      { key: 'shopping-baby', name: '母婴用品', keywords: ['奶粉', '尿布', '尿不湿', '玩具', '母婴', '婴儿'] },
    ],
  },
  {
    key: 'housing', name: '居住', kind: 'expense', icon: '🏠',
    keywords: ['住'],
    children: [
      { key: 'housing-rent', name: '房租房贷', keywords: ['房租', '房贷', '租金'] },
      { key: 'housing-utility', name: '水电燃气', keywords: ['水电', '电费', '水费', '燃气', '煤气', '取暖', '暖气'] },
      { key: 'housing-property', name: '物业维修', keywords: ['物业', '物业费', '维修', '装修'] },
    ],
  },
  {
    key: 'education', name: '教育', kind: 'expense', icon: '📚',
    keywords: ['学习', '上学'],
    children: [
      { key: 'education-tuition', name: '学费', keywords: ['学费', '幼儿园', '学校', '入学', '托管'] },
      { key: 'education-training', name: '补习培训', keywords: ['补习', '培训班', '补习班', '培训', '辅导', '兴趣班', '课时费', '一对一'] },
      { key: 'education-material', name: '书籍教材', keywords: ['书', '教材', '文具', '文具盒', '作业本', '绘本', '资料'] },
    ],
  },
  {
    key: 'medical', name: '医疗', kind: 'expense', icon: '💊',
    keywords: ['病'],
    children: [
      { key: 'medical-visit', name: '看病就诊', keywords: ['看病', '医院', '挂号', '门诊', '住院', '诊所', '手术', '体检', '牙医', '拔牙'] },
      { key: 'medical-medicine', name: '药品', keywords: ['药', '买药', '药店', '维生素'] },
      { key: 'medical-insurance', name: '保险', keywords: ['保险费', '医保', '社保', '商业保险'] },
    ],
  },
  {
    key: 'entertainment', name: '娱乐', kind: 'expense', icon: '🎮',
    keywords: ['玩'],
    children: [
      { key: 'entertainment-leisure', name: '旅游休闲', keywords: ['旅游', '门票', '景点', '酒店', '住宿', '度假', '露营'] },
      { key: 'entertainment-media', name: '影音娱乐', keywords: ['电影', '电影票', '游戏', 'KTV', '演唱会', '会员', '视频会员', '买书看'] },
      { key: 'entertainment-fitness', name: '运动健身', keywords: ['健身', '健身房', '游泳', '瑜伽', '球场', '球', '运动'] },
    ],
  },
  {
    key: 'communication', name: '通讯', kind: 'expense', icon: '📱',
    keywords: [],
    children: [
      { key: 'communication-phone', name: '话费流量', keywords: ['话费', '流量', '手机费', '宽带', '网费', '充值话费'] },
    ],
  },
  {
    key: 'social', name: '人情往来', kind: 'expense', icon: '🎁',
    keywords: [],
    children: [
      { key: 'social-gift', name: '礼物红包', keywords: ['礼物', '礼金', '随礼', '份子钱', '送礼', '红包礼'] },
      { key: 'social-dinner', name: '宴请', keywords: ['请客吃饭', '办酒席', '婚宴', '酒席'] },
    ],
  },
  {
    key: 'other-expense', name: '其他支出', kind: 'expense', icon: '📦',
    keywords: [],
    children: [],
  },
  {
    key: 'salary', name: '工资薪金', kind: 'income', icon: '💰',
    keywords: ['工资', '薪水', '月薪', '发薪', '发工资', '报酬', '劳务'],
    children: [],
  },
  {
    key: 'bonus', name: '奖金提成', kind: 'income', icon: '🎉',
    keywords: ['奖金', '年终奖', '提成', '绩效', '奖励', '补贴', '津贴'],
    children: [],
  },
  {
    key: 'invest', name: '投资理财', kind: 'income', icon: '📈',
    keywords: ['利息', '分红', '收益', '基金', '股票', '理财', '租金收入'],
    children: [],
  },
  {
    key: 'redpacket', name: '红包礼金收入', kind: 'income', icon: '🧧',
    keywords: ['红包', '压岁钱', '礼金收入'],
    children: [],
  },
  {
    key: 'parttime', name: '副业兼职', kind: 'income', icon: '💼',
    keywords: ['副业', '兼职', '外快', '接单', '稿费'],
    children: [],
  },
  {
    key: 'other-income', name: '其他收入', kind: 'income', icon: '➕',
    keywords: [],
    children: [],
  },
];

/** 把扁平化的分类（DB 返回结构：{id,name,kind,parent_id,keywords}）转成解析器好用的形式 */
export function buildCategoryIndex(rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return rows.map((r) => {
    const parent = r.parent_id ? byId.get(r.parent_id) : null;
    return {
      ...r,
      parentName: parent ? parent.name : null,
      fullName: parent ? `${parent.name}/${r.name}` : r.name,
    };
  });
}
