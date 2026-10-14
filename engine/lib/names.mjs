// 离线补全：汉字拼音表（覆盖 131 个角色名用到的全部 203 个汉字）+
// 官方英文名表（语料里没有拉丁名，靠这张表支持 Venti / Hu Tao 之类的查询）。
// 不依赖任何第三方包，不做任何网络请求。

export const CHAR_PINYIN = {
  一: 'yi', 七: 'qi', 万: 'wan', 丝: 'si', 丽: 'li', 久: 'jiu', 乌: 'wu', 九: 'jiu',
  云: 'yun', 五: 'wu', 亚: 'ya', 人: 'ren', 伊: 'yi', 优: 'you', 伦: 'lun', 伽: 'jia',
  依: 'yi', 偶: 'ou', 光: 'guang', 克: 'ke', 八: 'ba', 兰: 'lan', 兹: 'zi', 军: 'jun',
  凝: 'ning', 凯: 'kai', 利: 'li', 刻: 'ke', 北: 'bei', 千: 'qian', 华: 'hua', 卡: 'ka',
  卢: 'lu', 原: 'yuan', 可: 'ke', 叶: 'ye', 哥: 'ge', 嘉: 'jia', 因: 'yin', 坎: 'kan',
  埃: 'ai', 基: 'ji', 堇: 'jin', 塔: 'ta', 夏: 'xia', 多: 'duo', 夜: 'ye', 奇: 'qi',
  奈: 'nai', 奥: 'ao', 女: 'nv', 妮: 'ni', 妲: 'da', 娅: 'ya', 娜: 'na', 子: 'zi',
  宁: 'ning', 安: 'an', 宫: 'gong', 宵: 'xiao', 将: 'jiang', 尔: 'er', 尼: 'ni', 岐: 'qi',
  布: 'bu', 希: 'xi', 平: 'ping', 德: 'de', 心: 'xin', 忍: 'ren', 性: 'xing', 恩: 'en',
  恰: 'qia', 戴: 'dai', 托: 'tuo', 拉: 'la', 提: 'ti', 斗: 'dou', 斯: 'si', 旅: 'lv',
  早: 'zao', 明: 'ming', 晴: 'qing', 月: 'yue', 术: 'shu', 杜: 'du', 条: 'tiao', 林: 'lin',
  枫: 'feng', 柏: 'bai', 柚: 'you', 柯: 'ke', 格: 'ge', 桃: 'tao', 桑: 'sang', 梅: 'mei',
  梦: 'meng', 森: 'sen', 欧: 'ou', 比: 'bi', 沃: 'wo', 法: 'fa', 泷: 'long', 泽: 'ze',
  洛: 'luo', 派: 'pai', 流: 'liu', 浪: 'lang', 海: 'hai', 涅: 'nie', 温: 'wen', 潘: 'pan',
  烟: 'yan', 焱: 'yan', 爱: 'ai', 特: 'te', 玛: 'ma', 珂: 'ke', 珊: 'shan', 珐: 'fa',
  班: 'ban', 琳: 'lin', 琴: 'qin', 瑚: 'hu', 瑞: 'rui', 瑶: 'yao', 瓦: 'wa', 甘: 'gan',
  申: 'shen', 电: 'dian', 男: 'nan', 白: 'bai', 皮: 'pi', 砂: 'sha', 砚: 'yan', 神: 'shen',
  离: 'li', 秋: 'qiu', 米: 'mi', 糖: 'tang', 索: 'suo', 纳: 'na', 织: 'zhi', 绫: 'ling',
  绮: 'qi', 绯: 'fei', 维: 'wei', 罗: 'luo', 者: 'zhe', 耶: 'ye', 胡: 'hu', 良: 'liang',
  艾: 'ai', 芙: 'fu', 芭: 'ba', 茜: 'qian', 茵: 'yin', 荒: 'huang', 莉: 'li', 莎: 'sha',
  莫: 'mo', 莱: 'lai', 菈: 'la', 菱: 'ling', 菲: 'fei', 蒂: 'di', 蒙: 'meng', 蓝: 'lan',
  蕾: 'lei', 薇: 'wei', 藏: 'zang', 行: 'xing', 裟: 'sha', 西: 'xi', 见: 'jian', 诺: 'nuo',
  谢: 'xie', 贝: 'bei', 赛: 'sai', 辛: 'xin', 达: 'da', 迪: 'di', 那: 'na', 郎: 'lang',
  里: 'li', 重: 'chong', 野: 'ye', 钟: 'zhong', 闲: 'xian', 阿: 'a', 院: 'yuan', 雅: 'ya',
  雨: 'yu', 雯: 'wen', 雷: 'lei', 露: 'lu', 香: 'xiang', 马: 'ma', 魈: 'xiao', 鹤: 'he',
  鹿: 'lu', 黛: 'dai', 齐: 'qi',
};

/** 官方英文名（只收录确定性高的；其余角色的拼音检索依然可用）。 */
export const EN_NAMES = {
  温迪: 'Venti',
  钟离: 'Zhongli',
  雷电将军: 'Raiden Shogun',
  纳西妲: 'Nahida',
  芙宁娜: 'Furina',
  玛薇卡: 'Mavuika',
  哥伦比娅: 'Columbina',
  胡桃: 'Hu Tao',
  甘雨: 'Ganyu',
  魈: 'Xiao',
  刻晴: 'Keqing',
  七七: 'Qiqi',
  白术: 'Baizhu',
  香菱: 'Xiangling',
  重云: 'Chongyun',
  行秋: 'Xingqiu',
  辛焱: 'Xinyan',
  烟绯: 'Yanfei',
  云堇: 'Yun Jin',
  瑶瑶: 'Yaoyao',
  夜兰: 'Yelan',
  闲云: 'Xianyun',
  申鹤: 'Shenhe',
  嘉明: 'Gaming',
  蓝砚: 'Lan Yan',
  凝光: 'Ningguang',
  北斗: 'Beidou',
  迪卢克: 'Diluc',
  凯亚: 'Kaeya',
  琴: 'Jean',
  安柏: 'Amber',
  丽莎: 'Lisa',
  芭芭拉: 'Barbara',
  莫娜: 'Mona',
  可莉: 'Klee',
  阿贝多: 'Albedo',
  雷泽: 'Razor',
  班尼特: 'Bennett',
  菲谢尔: 'Fischl',
  诺艾尔: 'Noelle',
  砂糖: 'Sucrose',
  迪奥娜: 'Diona',
  优菈: 'Eula',
  罗莎莉亚: 'Rosaria',
  法尔伽: 'Varka',
  菲米尼: 'Freminet',
  米卡: 'Mika',
  鹿野院平藏: 'Shikanoin Heizou',
  神里绫华: 'Kamisato Ayaka',
  神里绫人: 'Kamisato Ayato',
  八重神子: 'Yae Miko',
  宵宫: 'Yoimiya',
  早柚: 'Sayu',
  枫原万叶: 'Kaedehara Kazuha',
  珊瑚宫心海: 'Sangonomiya Kokomi',
  托马: 'Thoma',
  五郎: 'Gorou',
  九条裟罗: 'Kujou Sara',
  久岐忍: 'Kuki Shinobu',
  荒泷一斗: 'Arataki Itto',
  达达利亚: 'Tartaglia',
  流浪者: 'Wanderer',
  那维莱特: 'Neuvillette',
  林尼: 'Lyney',
  琳妮特: 'Lynette',
  娜维娅: 'Navia',
  克洛琳德: 'Clorinde',
  夏洛蒂: 'Charlotte',
  莱欧斯利: 'Wriothesley',
  希格雯: 'Sigewinne',
  阿蕾奇诺: 'Arlecchino',
  千织: 'Chiori',
  夏沃蕾: 'Chevreuse',
  艾梅莉埃: 'Emilie',
  爱可菲: 'Escoffier',
  玛拉妮: 'Mualani',
  基尼奇: 'Kinich',
  恰斯卡: 'Chasca',
  茜特菈莉: 'Citlali',
  瓦雷莎: 'Varesa',
  伊安珊: 'Iansan',
  希诺宁: 'Xilonen',
  卡齐娜: 'Kachina',
  欧洛伦: 'Olorun',
  伊涅芙: 'Ineffa',
  梦见月瑞希: 'Yumemizuki Mizuki',
  赛诺: 'Cyno',
  提纳里: 'Tighnari',
  妮露: 'Nilou',
  柯莱: 'Collei',
  多莉: 'Dori',
  坎蒂丝: 'Candace',
  迪希雅: 'Dehya',
  艾尔海森: 'Alhaitham',
  卡维: 'Kaveh',
  珐露珊: 'Faruzan',
  莱依拉: 'Layla',
  绮良良: 'Kirara',
  多托雷: 'Dottore',
  皮耶罗: 'Pierro',
  潘塔罗涅: 'Pantalone',
  卡皮塔诺: 'Capitano',
  桑多涅: 'Sandrone',
  戴因斯雷布: 'Dainsleif',
  派蒙: 'Paimon',
  埃洛伊: 'Aloy',
  丝柯克: 'Skirk',
  杜林: 'Durin',
  艾莉丝: 'Alice',
  莱茵多特: 'Rhinedottir',
};

/** 名字 -> 连写拼音（未收录的字直接跳过，保证不抛错）。 */
export function pinyinOf(name) {
  const out = [];
  for (const ch of String(name)) {
    const p = CHAR_PINYIN[ch];
    if (p) out.push(p);
    else if (/[0-9a-zA-Z]/.test(ch)) out.push(ch.toLowerCase());
  }
  return out.join('');
}

/** 名字 -> 空格分隔拼音（支持「hu tao」这类分词查询）。 */
export function pinyinSpaced(name) {
  const out = [];
  for (const ch of String(name)) {
    const p = CHAR_PINYIN[ch];
    if (p) out.push(p);
  }
  return out.join(' ');
}

/**
 * 生成用于检索的补充关键词串（写进角色检索文档）。
 * 覆盖三种输入习惯：连写拼音、分词拼音、官方英文名。
 */
export function searchKeys(name) {
  const parts = [pinyinOf(name), pinyinSpaced(name)];
  const en = EN_NAMES[name];
  if (en) {
    parts.push(en, en.replace(/[^0-9a-zA-Z]+/g, ''));
  }
  return [...new Set(parts.filter(Boolean))].join(' ');
}

/** 检查拼音表对给定名字集合的覆盖率，返回缺失的汉字。 */
export function missingChars(names) {
  const miss = new Set();
  for (const n of names) for (const ch of n) if (/[\u4e00-\u9fff]/.test(ch) && !CHAR_PINYIN[ch]) miss.add(ch);
  return [...miss];
}

// ---------------------------------------------------------------- 单字名的边界判断
//
// 只有两个单字角色名：琴、魈。它们和常见名词同形，判断规则必须**只有一份** ——
// 原先 chat/retrieve.mjs（检索认不认得出）和 lib/v1-data.mjs（锚点算不算命中）各写了一
// 份，注释里还专门叮嘱「必须完全一致」，但改的时候照样会漏一处。
// 漏的后果是割裂：检索认出了角色、闸门却不认（回答是对的，依据却标成「较弱」）。

/** 句首命中时，下一个字必须是助词/查询词，不能是「声/键/弦/谱/师」这类构词成分。 */
export const SHORT_NEXT_OK = /^[的是在有和与跟这那怎会能把被了吗呢啊好谁什为多几哪介绍资语故天命属元武生星喜想爱叫说给看聊问帮写画]/;

/**
 * 单字名**前面**允许出现的字，分三类。判断顺序就是这里写的顺序。
 *
 * 背景：只有「琴」「魈」两个单字角色名，它们和常见名词同形，规则必须**只有一份**
 * （chat/retrieve.mjs 的检索 和 lib/v1-data.mjs 的锚点都用 shortNameAtOk）。
 */

/** ① 列举连接词：后面直接跟单字名时，一定是列举（「胡桃和琴」「七七、魈」）。 */
export const SHORT_PREV_OK = '和与跟及同或、，；：,;/';

/**
 * ② 「动词/介词 + 单字名」的前置字（单字即可判定）。
 *
 * 为什么需要这一条：只认连接词时，「介绍**一下琴**」「关**于琴**的语音」「我喜**欢魈**」
 * 这些正常问法里，单字名前一个字是汉字又不是连接词，于是整个角色认不出 ——
 * 检索退化成全文兜底，模型接着就说「知识库里没有琴」。
 *
 * 为什么是**白名单**而不是黑名单：黑名单挡不住没枚举到的乐器名
 *（实测「大提琴」「小提琴」「中提琴」的前一个字是「提」，「弹到琴弦」的是「到」）。
 * 白名单默认拒收，只会漏，不会把乐器认成角色。
 *
 * 刻意**不收**的字：「提」（大提琴/小提琴/中提琴）、「到」「弹」「钢」「风」「竖」「口」
 * 「月」「古」「木」「胡」「马」「柳」「扬」「洋」「钟」「手」「电」—— 它们结尾的词都是乐器。
 */
export const SHORT_PREV_LEAD = '绍识解道说讲聊看问谈于对欢厌想';

/**
 * ③ 只能用两字窗口判定的前置词：「提**到**琴」「说**到**琴」。
 * 单看「到」会把「弹到琴弦」认成角色，所以要求前面两个字整体对得上。
 */
export const SHORT_PREV_LEAD2 = /(提到|说到|问到|想到|讲到|聊到|谈到|看到|听到|查到|搜到|找到)$/;

/**
 * ③b 「查询类动词 + 一下」+ 单字名：「介绍**一下**琴」「了解**一下**魈」。
 *
 * 这里不能只把「下」加进前置字白名单 —— 那会连「弹**一下**琴」「放**一下**琴」一起认进来。
 * 所以要求「一下」前面确实是查询类动词。
 */
export const SHORT_PREV_LEAD3 = /(介绍|了解|认识|知道|说说|讲讲|聊聊|看看|问问|谈谈|想想|科普|评价)一下$/;

/**
 * ④ 紧跟单字名的**构词后缀**：命中就一律不认，不论前面是什么。
 *
 * 光看前一个字还不够：「看琴**谱**」「介绍琴**声**」「说到琴**弦**」的前置字都在白名单里，
 * 但「琴谱/琴声/琴弦」是构词（琴是乐器），不是那个角色。这一条是前置字白名单的安全网。
 */
export const SHORT_NEXT_BAD = /^[声键弦谱师曲音盒弓码凳托架柱袋布囊线枕台]/;

/**
 * 名字出现在 hay[at..at+len) 算不算真名。
 * @param {string} hay 已归一化（小写）的文本
 * @param {number} at 出现位置
 * @param {number} len 名字长度
 */
export function shortNameAtOk(hay, at, len) {
  if (at > 0) {
    // 构词后缀一票否决：琴声 / 琴键 / 琴谱 / 琴弦 …
    if (SHORT_NEXT_BAD.test(hay.slice(at + len, at + len + 1))) return false;
    const prev = hay[at - 1];
    if (SHORT_PREV_OK.includes(prev)) return true;      // ① 列举连接词后面：这是真名
    if (!/[\u4e00-\u9fff]/.test(prev)) return true;      // 前面不是汉字
    // ②③ 动词/介词后面：介绍一下琴 / 关于琴的语音 / 我喜欢魈 / 提到琴
    const before = hay.slice(0, at);
    return SHORT_PREV_LEAD.includes(prev)
      || SHORT_PREV_LEAD2.test(before)
      || SHORT_PREV_LEAD3.test(before);
  }
  const rest = hay.slice(at + len);
  if (!rest) return true;                              // 问句就是这个名字
  return SHORT_NEXT_OK.test(rest[0]);
}

