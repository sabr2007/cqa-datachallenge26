"""Правила-сигналы на регулярных выражениях (RU / KZ / EN).

Сигналы — подсказки модели, а не вердикт: «нашли приветствие», «есть фраза,
похожая на предложение перевести деньги лично». Решение принимает модель
по тексту транскрипта.
"""

import re
from dataclasses import dataclass

_KZ_LETTERS = re.compile(r"[әғқңөұүһіӘҒҚҢӨҰҮҺІ]")
_CYRILLIC = re.compile(r"[а-яёА-ЯЁ]")
_LATIN = re.compile(r"[a-zA-Z]")

GREETINGS: dict[str, re.Pattern[str]] = {
    "RU": re.compile(
        r"\b(здравствуйте|здравствуй|добр(ый|ое|ого)\s+(день|вечер|утро|дня|времени(\s+суток)?)"
        r"|приветствую|привет)\b",
        re.IGNORECASE,
    ),
    "KZ": re.compile(
        r"(сәлеметсіз(дер)?\s*(бе|ме)?|сәлем|қайырлы\s+(күн|таң|кеш)|армысыз)", re.IGNORECASE
    ),
    "EN": re.compile(
        r"\b(hello|hi|hey|good\s+(morning|afternoon|evening|day)|greetings)\b", re.IGNORECASE
    ),
}

_NAME = r"[A-ZА-ЯЁӘҒҚҢӨҰҮҺІ][\w’'-]+"
INTRODUCTIONS: dict[str, re.Pattern[str]] = {
    "RU": re.compile(
        rf"((?i:меня\s+зовут)\s+{_NAME}|(?<![\w-])(?i:я)\s+{_NAME}|(?i:на\s+связи|с\s+вами)\s+{_NAME}"
        rf"|(?i:ваш\s+)?(?i:оператор|специалист|менеджер)\s+{_NAME})"
    ),
    "KZ": re.compile(rf"((?i:менің\s+атым|атым)\s+{_NAME}|(?<![\w-])(?i:мен)\s+{_NAME})"),
    "EN": re.compile(
        rf"((?i:my\s+name\s+is)\s+{_NAME}|(?<![\w-])(?i:i['’]m|i\s+am)\s+{_NAME}"
        rf"|(?i:this\s+is)\s+{_NAME})"
    ),
    "ANY": re.compile(r"\[(имя скрыто|аты жасырылған|name hidden|name redacted)\]", re.IGNORECASE),
}

HANDOFF = re.compile(
    r"(эскалац|переда\w*\s+(чат\s+)?оператор|подключ\w*\s+оператор|соедин\w*\s+с\s+оператор"
    r"|операторға\s+(жіберілді|қосыл)|transferred\s+to\s+an?\s+(agent|operator)|escalat"
    r"|connected\s+to\s+an?\s+(agent|operator))",
    re.IGNORECASE,
)
BOT_WAIT_FOR_OPERATOR = re.compile(
    r"(оператор\s+скоро\s+подключится|оператор\s+жақында|agent\s+will\s+join)", re.IGNORECASE
)
IDENTITY_CONFIRMED = re.compile(
    r"(личность\s+клиента\s+подтверждена|клиенттің\s+жеке\s+басы\s+расталды"
    r"|(customer|client)\s+identity\s+verified|identity\s+(confirmed|verified))",
    re.IGNORECASE,
)
CLIENT_LEFT = re.compile(
    r"(клиент\s+покинул|соединение\s+с\s+клиентом\s+прервано|байланыс\s+үзілді"
    r"|клиент\s+чаттан\s+шықты|connection\s+to\s+(the\s+)?customer\s+lost"
    r"|customer\s+left|client\s+left)",
    re.IGNORECASE,
)
OPERATOR_CLOSED = re.compile(
    r"(оператор\s+закрыл\s+чат|оператор\s+чатты\s+жапты|agent\s+closed\s+the\s+chat"
    r"|operator\s+closed\s+the\s+chat|чат\s+закрыт)",
    re.IGNORECASE,
)
WAIT_WARNING = re.compile(
    r"(проверю|проверяю|проверим|уточню|уточняю|посмотрю|сейчас\s+посмотр\w*|минут\w*"
    r"|подождите|ожидайте|ожидани\w*|секунд\w*|момент|тексеремін|тексеріп|күте\s+тұрыңыз"
    r"|қарап\s+(шығамын|көрейін)|қараймын|let\s+me\s+check|i'?ll\s+check|checking"
    r"|one\s+moment|please\s+wait|hold\s+on|bear\s+with|a\s+(moment|minute)|few\s+minutes)",
    re.IGNORECASE,
)

SUSPICIOUS: dict[str, re.Pattern[str]] = {
    "перевод денег оператору лично": re.compile(
        r"(на\s+(мою|мой|свою|личную)\s+карт|мне\s+на\s+карт|переведите\s+(их\s+)?мне|скиньте"
        r"\s+(деньги\s+)?мне|лично\s+мне|я\s+сам\s+(их\s+)?вложу|на\s+мой\s+(личный\s+)?(счёт|счет)"
        r"|маған\s+(аударыңыз|жіберіңіз|салыңыз)|менің\s+картам|жеке\s+картам"
        r"|(transfer|send)\s+(the\s+)?(money|funds|it)?\s*to\s+me|to\s+my\s+(personal\s+)?(card|account)"
        r"|invest\s+it\s+for\s+you)",
        re.IGNORECASE,
    ),
    "личный контакт / платная консультация": re.compile(
        r"(личн\w*\s+(номер|телефон)|мой\s+(номер|телефон|whatsapp|телеграм)|whatsapp|ватсап"
        r"|телеграм|telegram|созвон\w*|частн\w*\s+консультац|платн\w*\s+консультац|за\s+плату"
        r"|за\s+отдельную\s+плату|жеке\s+(нөмір|телефон|кеңес)|ақылы\s+кеңес|ақыға"
        r"|personal\s+(number|phone)|private\s+(consultation|session|call)|for\s+a\s+fee"
        r"|paid\s+consultation|my\s+(number|phone))",
        re.IGNORECASE,
    ),
    "возможное оскорбление": re.compile(
        r"(читать\s+умеете|не\s+умеете\s+читать|вы\s+что,?\s+не\s+понимаете|туп\w*|глуп\w*"
        r"|идиот\w*|дур(ак|а|ой)\b|бестолк\w*|сами\s+виноваты|оқи\s+(алмайсыз|білесіз\s+бе)"
        r"|ақымақ|can'?t\s+you\s+read|can\s+you\s+(even\s+)?read|stupid|idiot|dumb|clueless)",
        re.IGNORECASE,
    ),
    "данные другого клиента / внутренние данные": re.compile(
        r"(друго\w+\s+клиент\w*|чуж\w+\s+(счёт|счет|данн)|басқа\s+клиент"
        r"|another\s+(client|customer)|other\s+(client|customer)'?s)",
        re.IGNORECASE,
    ),
}
ACCOUNT_DATA = re.compile(
    r"(на\s+вашем\s+(сч[её]те|счету)|ваш\s+баланс|по\s+вашему\s+сч[её]ту|у\s+вас\s+на\s+сч[её]те"
    r"|сіздің\s+шотыңызда|шотыңызда|on\s+your\s+account|your\s+balance|in\s+your\s+account)",
    re.IGNORECASE,
)


@dataclass(frozen=True, slots=True)
class Match:
    index: int
    label: str
    phrase: str


def detect_language(text: str) -> str | None:
    """RU / KZ / EN по алфавиту; None — если букв почти нет."""
    if _KZ_LETTERS.search(text):
        return "KZ"
    cyrillic, latin = len(_CYRILLIC.findall(text)), len(_LATIN.findall(text))
    if cyrillic + latin < 2:
        return None
    return "RU" if cyrillic >= latin else "EN"


def find_greeting(text: str) -> tuple[str, str] | None:
    """(язык, фраза) первого найденного приветствия."""
    found = [
        (match.start(), language, match.group(0))
        for language, pattern in GREETINGS.items()
        if (match := pattern.search(text))
    ]
    if not found:
        return None
    _, language, phrase = min(found)
    return language, phrase


def find_introduction(text: str) -> str | None:
    for pattern in INTRODUCTIONS.values():
        if match := pattern.search(text):
            return match.group(0)
    return None


def find_suspicious(index: int, text: str) -> list[Match]:
    return [
        Match(index, label, match.group(0))
        for label, pattern in SUSPICIOUS.items()
        if (match := pattern.search(text))
    ]
