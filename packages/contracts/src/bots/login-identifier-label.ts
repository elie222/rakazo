// Case, accents and compatibility forms are folded away so a label compares with the lists below
// by letters alone: Teléfono is telefono. Kana voiced marks stay (ハ is not バ) and the text is
// recomposed, so a Korean or Japanese word matches only whole syllables and kana.
function foldLabel(text: string): string {
  return text
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/(?![\u3099\u309A])[\p{M}\p{Cf}]/gu, "")
    .normalize("NFC")
    .toLowerCase();
}

function foldWords(words: readonly string[]): ReadonlySet<string> {
  return new Set(words.map(foldLabel));
}

// A field starts visible only when every word of its label is one of these and at least one is
// an identifier. Any other word, a misspelling or a look-alike letter included, keeps it hidden.
// Never list a word that can name a secret (password, PIN, code, key) in any language.
const IDENTIFIER_WORDS = foldWords([
  // English.
  "id",
  "user",
  "username",
  "login",
  "email",
  "mail",
  "phone",
  "mobile",
  "cell",
  "tel",
  "telephone",
  "account",
  "member",
  "customer",
  // Hebrew.
  "זהות",
  "תז",
  "טלפון",
  "נייד",
  "פלאפון",
  "סלולרי",
  "מייל",
  "אימייל",
  "דואל",
  "משתמש",
  "חשבון",
  "לקוח",
  "חבר",
  // Chinese, Simplified and Traditional.
  "用户",
  "用戶",
  "使用者",
  "账号",
  "帐号",
  "賬號",
  "帳號",
  "账户",
  "帐户",
  "賬戶",
  "帳戶",
  "会员",
  "會員",
  "客户",
  "客戶",
  "学号",
  "學號",
  "工号",
  "昵称",
  "暱稱",
  "邮箱",
  "郵箱",
  "信箱",
  "邮件",
  "郵件",
  "电邮",
  "電郵",
  "手机",
  "手機",
  "电话",
  "電話",
  "固话",
  "座机",
  "移动电话",
  "行動電話",
  "身份证",
  "身分證",
  "证件",
  "證件",
  "护照",
  "護照",
  "纳税人识别号",
  "统一编号",
  "統一編號",
  "准考证",
  "考生号",
  "注册号",
  // Japanese.
  "ユーザー",
  "ユーザ",
  "ログイン",
  "アカウント",
  "メール",
  "携帯",
  "顧客",
  // Korean.
  "아이디",
  "사용자",
  "계정",
  "이메일",
  "휴대폰",
  "핸드폰",
  "전화",
  "회원",
  "고객",
  // Spanish.
  "usuario",
  "correo",
  "telefono",
  "movil",
  "cuenta",
  "dni",
  "identificacion",
  // French (d'utilisateur loses its apostrophe).
  "identifiant",
  "utilisateur",
  "dutilisateur",
  "courriel",
  "compte",
  // German.
  "benutzername",
  "nutzername",
  "kennung",
  "telefon",
  "telefonnummer",
  "konto",
  "kundennummer",
  "mobil",
  "handy",
]);
const FILLER_WORDS = foldWords([
  // English.
  "number",
  "no",
  "num",
  "name",
  "address",
  "or",
  "and",
  "of",
  "your",
  "the",
  "last",
  "first",
  "digit",
  "digits",
  "national",
  "tax",
  "employee",
  "e",
  // Hebrew.
  "תעודת",
  "מספר",
  "שם",
  "כתובת",
  "או",
  "של",
  "ו",
  "אחרונות",
  "ספרות",
  "לאומי",
  "עובד",
  "מס",
  // Chinese, Simplified and Traditional.
  "号码",
  "號碼",
  "编号",
  "編號",
  "号",
  "號",
  "字號",
  "名称",
  "名稱",
  "名",
  "地址",
  "或",
  "与",
  "與",
  "和",
  "及",
  "您的",
  "你的",
  "登录",
  "登陆",
  "登入",
  "个人",
  "個人",
  "企业",
  "企業",
  "员工",
  "員工",
  "最后",
  "最後",
  "后",
  "後",
  "位",
  "数字",
  "數字",
  "电子",
  "電子",
  "联系",
  "聯絡",
  "联络",
  // Japanese.
  "番号",
  "アドレス",
  "の",
  "または",
  // Korean.
  "번호",
  "명",
  "이름",
  "주소",
  "또는",
  "및",
  // Spanish.
  "numero",
  "nombre",
  "direccion",
  "electronico",
  "de",
  "del",
  "el",
  "la",
  "o",
  "y",
  // French.
  "nom",
  "adresse",
  "electronique",
  "votre",
  "du",
  "le",
  "ou",
  "et",
  // German.
  "nummer",
  "oder",
  "und",
  "ihre",
  "ihr",
]);

// Chinese, Japanese and Korean put no spaces between words, so a run of their letters is cut into
// the longest known words, left to right. A run with any part that is no known word stays whole,
// and so stays an unknown word.
const CJK = "\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Hangul}";
const CJK_ONLY = new RegExp(`^[${CJK}]+$`, "u");
const SCRIPT_RUNS = new RegExp(`[${CJK}]+|[^${CJK}]+`, "gu");
const CJK_WORDS = new Set(
  [...IDENTIFIER_WORDS, ...FILLER_WORDS].filter((word) => CJK_ONLY.test(word)),
);
const LONGEST_CJK_WORD = Math.max(...[...CJK_WORDS].map((word) => word.length));

function segmentCjk(run: string): string[] {
  const parts: string[] = [];
  for (let start = 0; start < run.length; ) {
    let end = Math.min(run.length, start + LONGEST_CJK_WORD);
    while (end > start && !CJK_WORDS.has(run.slice(start, end))) end--;
    if (end === start) return [run];
    parts.push(run.slice(start, end));
    start = end;
  }
  return parts;
}

function splitScripts(word: string): string[] {
  return (word.match(SCRIPT_RUNS) ?? []).flatMap((run) =>
    CJK_ONLY.test(run) ? segmentCjk(run) : [run],
  );
}

function labelWords(label: string): string[] {
  return (
    foldLabel(label)
      // Spaces and punctuation separate words; any other symbol or emoji is a word of its own, so a
      // label with one is not made only of known words.
      .match(/[\p{L}\p{N}.'"׳״]+|[^\p{L}\p{N}\p{Z}\s\p{P}№]/gu)
      ?.map((word) => word.replace(/[.'"׳״]/g, ""))
      .filter(Boolean)
      .flatMap(splitScripts) ?? []
  );
}

function knownWord(word: string, known: ReadonlySet<string>): boolean {
  // Hebrew attaches "the" to a word: הטלפון.
  return known.has(word) || (word.startsWith("ה") && known.has(word.slice(1)));
}

/** Whether a label is made only of identifier and plain filler words, such as "Phone number". */
export function isIdentifierLabel(label: string): boolean {
  const words = labelWords(label);
  return (
    words.some((word) => knownWord(word, IDENTIFIER_WORDS)) &&
    words.every(
      (word) =>
        /^\p{N}+$/u.test(word) ||
        knownWord(word, IDENTIFIER_WORDS) ||
        knownWord(word, FILLER_WORDS),
    )
  );
}
