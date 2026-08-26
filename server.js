import express from "express";
import WebSocket from "ws";
import OpenAI from "openai";
import dotenv from "dotenv";
import { randomUUID } from "crypto";
import { franc } from "franc-min";

dotenv.config();

const app = express();
// Accept JSON bodies (Make scenarios that already work).
app.use(express.json({ limit: "1mb" }));
// Also accept application/x-www-form-urlencoded bodies. ManyChat (via Make)
// can send messages in this format to avoid JSON escaping issues with
// special characters in the user's input (quotes, newlines, emojis, etc.).
// Express automatically decodes URL-encoded values, so by the time the
// /chat handler reads req.body the message field is clean plain text again.
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

const PORT = process.env.PORT || 3000;

const ELEVEN_TIMEOUT_MS = Number(process.env.ELEVEN_TIMEOUT_MS || 20000);
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 12000);
const PAUSE_CLASSIFIER_TIMEOUT_MS = Number(
  process.env.PAUSE_CLASSIFIER_TIMEOUT_MS || 5000
);
const CHECKOUT_CLASSIFIER_TIMEOUT_MS = Number(
  process.env.CHECKOUT_CLASSIFIER_TIMEOUT_MS || 6000
);
const PAUSE_MIN_RESUME_MS = Number(
  process.env.PAUSE_MIN_RESUME_MS || 30 * 60 * 1000
);

const MAX_CONTEXT_MESSAGES = Number(process.env.MAX_CONTEXT_MESSAGES || 30);
const EXTRACTOR_CONTEXT_MESSAGES = Number(process.env.EXTRACTOR_CONTEXT_MESSAGES || 20);
const LANGUAGE_TEXT_MIN_CHARS = Number(process.env.LANGUAGE_TEXT_MIN_CHARS || 15);
const MAX_MESSAGE_CHARS = Number(process.env.MAX_MESSAGE_CHARS || 500);
const MAX_SUMMARY_CHARS = Number(process.env.MAX_SUMMARY_CHARS || 900);
const MAX_GOAL_CHARS = Number(process.env.MAX_GOAL_CHARS || 300);
const MAX_OBJECTIONS_CHARS = Number(process.env.MAX_OBJECTIONS_CHARS || 400);
const MAX_SHORT_FIELD_CHARS = Number(process.env.MAX_SHORT_FIELD_CHARS || 30);

const NO_REPLY = "__NO_REPLY__";

const FALLBACK_REPLIES = {
  nl: "Er ging iets mis met mijn antwoord. Kun je je bericht nog een keer sturen?",
  en: "Something went wrong with my reply. Could you send your message again?",
  fr: "Un problème est survenu avec ma réponse. Peux-tu renvoyer ton message ?",
  de: "Bei meiner Antwort ist etwas schiefgegangen. Kannst du deine Nachricht noch einmal senden?",
  it: "Si è verificato un problema con la mia risposta. Puoi inviare di nuovo il tuo messaggio?",
  es: "Ha ocurrido un problema con mi respuesta. ¿Puedes enviar tu mensaje de nuevo?",
  pt: "Ocorreu um problema com a minha resposta. Podes enviar novamente a tua mensagem?",
  pl: "Wystąpił problem z moją odpowiedzią. Czy możesz wysłać wiadomość jeszcze raz?",
};

function fallbackReplyForLanguage(language) {
  return FALLBACK_REPLIES[language] || FALLBACK_REPLIES.en;
}

const WELCOME_MESSAGE =
  "Hallo, ik ben Emma 😊\n\n" +
  "Ik help dagelijks mensen om hun gezondheidsdoelen te bereiken en ik denk graag met je mee 🤗\n\n" +
  "We hebben al tienduizenden mensen geholpen en ik denk dat ik jou ook goed kan helpen 💚\n\n" +
  "Vertel eens, waar zou jij het allerliefst verandering in willen zien? 💚\n\n" +
  "Je mag zo uitgebreid of juist zo kort antwoorden als je wilt. Alles is goed 🤗\n\n" +
  "Vertel bijvoorbeeld iets over je doel, waar je tegenaan loopt of wat je al geprobeerd hebt.";

// This opening belongs to the French MARKET, not to the French language.
// It is selected only for customer_country FR. A French-speaking Belgian
// receives the regular welcome below in French and stays in the Belgian flow.
const FRANCE_WELCOME_MESSAGE =
  "Coucou ! \u{1F60A} Super que tu aies répondu !\n\n" +
  "Tu souhaites perdre du poids ? Je serais ravie de t’aider à y arriver.\n\n" +
  "J’ai déjà accompagné des milliers de femmes et d’hommes avec de très beaux résultats, et surtout sans le fameux effet yo-yo tant redouté !\n\n" +
  "La plupart avaient pourtant déjà essayé plein de choses, sans obtenir les résultats qu’ils espéraient.\n\n" +
  "Est-ce que je peux te demander ce que tu as déjà essayé ?";

// One hardcoded welcome message per supported language. This message never
// touches the LLM, so the most-seen message is guaranteed correct in every
// language. The Dutch text above is the reference version.
const WELCOME_MESSAGES = {
  nl: WELCOME_MESSAGE,
  en:
    "Hi, I'm Emma \u{1F60A}\n\n" +
    "Every day I help people work toward their health goals, and I'm happy to think things through with you \u{1F917}\n\n" +
    "We've already helped tens of thousands of people, and I believe I can help you too \u{1F49A}\n\n" +
    "Tell me, what would you most like to see change? \u{1F49A}\n\n" +
    "You can answer in as much or as little detail as you like. Anything is fine \u{1F917}\n\n" +
    "For example, tell me about your goal, what you're struggling with, or what you've already tried.",
  fr:
    "Bonjour, je suis Emma \u{1F60A}\n\n" +
    "J’aide chaque jour des personnes à atteindre leurs objectifs de santé et je serais ravie de réfléchir avec toi à ce qui pourrait te convenir \u{1F917}\n\n" +
    "Nous avons déjà aidé des dizaines de milliers de personnes et je pense pouvoir aussi bien t’aider \u{1F49A}\n\n" +
    "Dis-moi, qu’aimerais-tu le plus voir changer ? \u{1F49A}\n\n" +
    "Tu peux répondre de façon très détaillée ou très brièvement. Tout me va \u{1F917}\n\n" +
    "Tu peux par exemple me parler de ton objectif, de ce qui te bloque ou de ce que tu as déjà essayé.",
  de:
    "Hallo, ich bin Emma \u{1F60A}\n\n" +
    "Ich helfe jeden Tag Menschen dabei, ihre Gesundheitsziele zu erreichen, und denke gern gemeinsam mit dir nach \u{1F917}\n\n" +
    "Wir haben bereits Zehntausenden Menschen geholfen und ich glaube, dass ich auch dir gut helfen kann \u{1F49A}\n\n" +
    "Erz\u00e4hl mal, was w\u00fcrdest du am allerliebsten ver\u00e4ndern? \u{1F49A}\n\n" +
    "Du kannst so ausf\u00fchrlich oder so kurz antworten, wie du m\u00f6chtest. Alles ist in Ordnung \u{1F917}\n\n" +
    "Erz\u00e4hl zum Beispiel etwas \u00fcber dein Ziel, woran du gerade scheiterst oder was du schon ausprobiert hast.",
  it:
    "Ciao, sono Emma \u{1F60A}\n\n" +
    "Ogni giorno aiuto le persone a raggiungere i loro obiettivi di salute e mi fa piacere ragionare insieme a te \u{1F917}\n\n" +
    "Abbiamo gi\u00e0 aiutato decine di migliaia di persone e penso di poter aiutare bene anche te \u{1F49A}\n\n" +
    "Dimmi, quale cambiamento vorresti vedere pi\u00f9 di ogni altra cosa? \u{1F49A}\n\n" +
    "Puoi rispondere in modo dettagliato oppure molto breve. Va bene tutto \u{1F917}\n\n" +
    "Per esempio, puoi raccontarmi il tuo obiettivo, ci\u00f2 che ti sta bloccando o cosa hai gi\u00e0 provato.",
  es:
    "Hola, soy Emma \u{1F60A}\n\n" +
    "Cada d\u00eda ayudo a personas a alcanzar sus objetivos de salud y me gusta pensar contigo en lo que necesitas \u{1F917}\n\n" +
    "Ya hemos ayudado a decenas de miles de personas y creo que tambi\u00e9n puedo ayudarte bien a ti \u{1F49A}\n\n" +
    "Cu\u00e9ntame, \u00bfqu\u00e9 es lo que m\u00e1s te gustar\u00eda cambiar? \u{1F49A}\n\n" +
    "Puedes responder con todo el detalle que quieras o de forma muy breve. Todo est\u00e1 bien \u{1F917}\n\n" +
    "Por ejemplo, puedes contarme cu\u00e1l es tu objetivo, qu\u00e9 te est\u00e1 frenando o qu\u00e9 has probado hasta ahora.",
  pt:
    "Ol\u00e1, sou a Emma \u{1F60A}\n\n" +
    "Todos os dias ajudo pessoas a alcan\u00e7ar os seus objetivos de sa\u00fade e gosto de pensar contigo no que pode funcionar melhor para ti \u{1F917}\n\n" +
    "J\u00e1 ajud\u00e1mos dezenas de milhares de pessoas e acredito que tamb\u00e9m te posso ajudar \u{1F49A}\n\n" +
    "Conta-me, o que gostarias mesmo de mudar? \u{1F49A}\n\n" +
    "Podes responder com o detalhe que quiseres ou de forma muito breve. Est\u00e1 tudo bem \u{1F917}\n\n" +
    "Por exemplo, podes contar-me qual \u00e9 o teu objetivo, o que te est\u00e1 a impedir de avan\u00e7ar ou o que j\u00e1 tentaste.",
  pl:
    "Cze\u015b\u0107, jestem Emma \u{1F60A}\n\n" +
    "Ka\u017cdego dnia pomagam ludziom osi\u0105ga\u0107 cele zdrowotne i ch\u0119tnie zastanowi\u0119 si\u0119 razem z Tob\u0105, co b\u0119dzie najlepsze \u{1F917}\n\n" +
    "Pomogli\u015bmy ju\u017c dziesi\u0105tkom tysi\u0119cy os\u00f3b i my\u015bl\u0119, \u017ce Tobie te\u017c mog\u0119 dobrze pom\u00f3c \u{1F49A}\n\n" +
    "Powiedz, co najbardziej chcia\u0142aby\u015b zmieni\u0107? \u{1F49A}\n\n" +
    "Mo\u017cesz odpowiedzie\u0107 bardzo szczeg\u00f3\u0142owo albo kr\u00f3tko. Ka\u017cda odpowied\u017a jest w porz\u0105dku \u{1F917}\n\n" +
    "Mo\u017cesz na przyk\u0142ad opisa\u0107 sw\u00f3j cel, to, co Ci\u0119 teraz blokuje, albo czego ju\u017c pr\u00f3bowa\u0142a\u015b.",
};

const FRANCE_WELCOME_MESSAGES = {
  nl:
    "Hoi! 😊 Super dat je hebt gereageerd!\n\n" +
    "Wil je graag afvallen? Ik help je heel graag om dat voor elkaar te krijgen.\n\n" +
    "Ik heb al duizenden vrouwen en mannen begeleid met prachtige resultaten, en vooral zonder het gevreesde jojo-effect.\n\n" +
    "De meesten hadden daarvoor al van alles geprobeerd, zonder de resultaten te behalen waarop ze hoopten.\n\n" +
    "Mag ik vragen wat jij al hebt geprobeerd?",
  en:
    "Hi! 😊 It's great that you replied!\n\n" +
    "Would you like to lose weight? I'd be very happy to help you achieve that.\n\n" +
    "I've already supported thousands of women and men with wonderful results, most importantly without the dreaded yo-yo effect.\n\n" +
    "Most of them had already tried all sorts of things without getting the results they hoped for.\n\n" +
    "May I ask what you've already tried?",
  fr: FRANCE_WELCOME_MESSAGE,
  de:
    "Hallo! 😊 Schön, dass du geantwortet hast!\n\n" +
    "Möchtest du abnehmen? Ich würde dir sehr gern dabei helfen.\n\n" +
    "Ich habe bereits Tausende Frauen und Männer mit großartigen Ergebnissen begleitet, vor allem ohne den gefürchteten Jo-Jo-Effekt.\n\n" +
    "Die meisten hatten vorher schon vieles ausprobiert, ohne die erhofften Ergebnisse zu erzielen.\n\n" +
    "Darf ich fragen, was du bereits ausprobiert hast?",
  it:
    "Ciao! 😊 Che bello che hai risposto!\n\n" +
    "Vorresti perdere peso? Sarei davvero felice di aiutarti a riuscirci.\n\n" +
    "Ho già seguito migliaia di donne e uomini con risultati splendidi e soprattutto senza il temuto effetto yo-yo.\n\n" +
    "La maggior parte aveva già provato tante cose senza ottenere i risultati sperati.\n\n" +
    "Posso chiederti che cosa hai già provato?",
  es:
    "¡Hola! 😊 ¡Qué bien que hayas respondido!\n\n" +
    "¿Te gustaría perder peso? Estaré encantada de ayudarte a conseguirlo.\n\n" +
    "Ya he acompañado a miles de mujeres y hombres con resultados preciosos y, sobre todo, sin el temido efecto rebote.\n\n" +
    "La mayoría ya había probado muchas cosas sin conseguir los resultados que esperaba.\n\n" +
    "¿Puedo preguntarte qué has probado hasta ahora?",
  pt:
    "Olá! 😊 Que bom teres respondido!\n\n" +
    "Gostarias de perder peso? Terei todo o gosto em ajudar-te a conseguir isso.\n\n" +
    "Já acompanhei milhares de mulheres e homens com excelentes resultados e, sobretudo, sem o tão receado efeito ioiô.\n\n" +
    "A maioria já tinha tentado várias coisas sem alcançar os resultados que esperava.\n\n" +
    "Posso perguntar-te o que já tentaste?",
  pl:
    "Cześć! 😊 Super, że odpisałaś!\n\n" +
    "Chcesz schudnąć? Z przyjemnością pomogę Ci osiągnąć ten cel.\n\n" +
    "Pomogłam już tysiącom kobiet i mężczyzn osiągnąć świetne rezultaty, przede wszystkim bez obawianego efektu jo-jo.\n\n" +
    "Większość z nich próbowała wcześniej wielu rzeczy, ale nie uzyskała oczekiwanych rezultatów.\n\n" +
    "Czy mogę zapytać, czego już próbowałaś?",
};

function welcomeMessageFor(conversationLanguage, customerCountry) {
  if ((customerCountry || "").toUpperCase() === "FR") {
    return (
      FRANCE_WELCOME_MESSAGES[conversationLanguage] ||
      FRANCE_WELCOME_MESSAGES.en
    );
  }
  return WELCOME_MESSAGES[conversationLanguage] || WELCOME_MESSAGES.en;
}

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/* ----------------------------- BASIC HELPERS ----------------------------- */

function cleanText(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function removePromptLeakTerms(value) {
  if (value === null || value === undefined) return "";

  return String(value)
    .replace(/\bneutrale afsluiting\b/gi, "")
    .replace(/\bkorte erkenning\b/gi, "")
    .replace(/\bduidelijke afbakening\b/gi, "")
    .replace(/\bdoorverwijzing\b/gi, "")
    .replace(/\bzonder verkoopdruk\b/gi, "")
    .replace(/\bstructuur van het antwoord\b/gi, "")
    .replace(/\bmedische trigger\b/gi, "")
    .replace(/\bmedical trigger\b/gi, "")
    .replace(/\bsalesflow\b/gi, "")
    .replace(/\bexit-conditie\b/gi, "")
    .replace(/\bexit conditie\b/gi, "")
    .replace(/\bcontextblok\b/gi, "")
    .replace(/\bruntime context\b/gi, "")
    .replace(/\bruntime_state\b/gi, "")
    .replace(/\bcrm_memory\b/gi, "")
    .replace(/\brepetition_guard\b/gi, "")
    .replace(/\blatest_user_message\b/gi, "")
    .replace(/\brecent_conversation_history\b/gi, "");
}

function cleanReplyText(value) {
  if (value === null || value === undefined) return "";

  return removePromptLeakTerms(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    // Remove AI-tell dashes. " — " / " – " between words become a comma;
    // a dash glued to text becomes nothing; a leading "- " bullet is kept.
    .replace(/\s+[\u2014\u2013]\s+/g, ", ")
    .replace(/(\S)[\u2014\u2013](\S)/g, "$1 $2")
    .replace(/[\u2014\u2013]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The website exists in three variants that must be tracked independently:
// the plain site (Stap 4), the testimonials page (Stap 3) and the program
// explanation page (decision help). All three contain "nutritionworks.online",
// so plain-substring matching would let one block the others.
const PLAIN_WEBSITE_LINK_PATTERN = /nutritionworks\.online(?!\/?#)/i;
const TESTIMONIALS_LINK_PATTERN = /nutritionworks\.online\/?#testimonials/i;
const PROGRAMMA_INFO_LINK_PATTERN = /nutritionworks\.online\/?#programma-info/i;

function hasPatternBeenSent(messages, pattern) {
  return messages.some(
    (msg) => msg.role === "emma" && pattern.test(cleanText(msg.message_text))
  );
}

// Deterministic removal of forbidden phrases the prompt alone could not
// suppress reliably: "welcome back" openers and "are you still there?"
// chasers. Applied to every reply.
function stripForbiddenReplyPhrases(value) {
  const text = cleanReplyText(value);
  if (!text) return text;
  // Emojis often end a sentence without punctuation, so they count as
  // sentence boundaries in these patterns.
  const B = "\\n.!?\\u{2600}-\\u{27BF}\\u{1F300}-\\u{1FAFF}";
  const E = "[.!?\\u2026\\u{2600}-\\u{27BF}\\u{1F300}-\\u{1FAFF}]*";
  let out = text
    // "Welkom terug!", "Welkom terug 😊 ..." — strip the phrase/sentence
    .replace(new RegExp(`(^|\\n)\\s*welkom terug[^${B}]*${E}\\s*`, "giu"), "$1")
    // "Goed/Fijn/Leuk dat je er weer bent", "Goed om je weer te horen", etc.
    .replace(
      new RegExp(
        `(^|[\\n.!?\\u2026]\\s*)(goed|fijn|leuk|mooi)\\s+(dat|om)\\s+je\\s+(er\\s+)?weer[^${B}]*${E}\\s*`,
        "giu"
      ),
      "$1"
    )
    // Any sentence containing "ben je er nog"
    .replace(new RegExp(`[^${B}]*ben je er nog[^${B}]*\\??\\s*`, "giu"), "");

  const multilingualForbiddenPatterns = [
    /(^|\n)\s*welcome back[^\n.!?]*[.!?…]*\s*/giu,
    /(^|\n)\s*(?:glad|good|nice) (?:to have you back|to hear from you again)[^\n.!?]*[.!?…]*\s*/giu,
    /(^|\n)\s*bon retour[^\n.!?]*[.!?…]*\s*/giu,
    /(^|\n)\s*(?:contente?|heureuse?) de (?:te revoir|avoir de tes nouvelles)[^\n.!?]*[.!?…]*\s*/giu,
    /(^|\n)\s*willkommen zur[uü]ck[^\n.!?]*[.!?…]*\s*/giu,
    /(^|\n)\s*sch[oö]n,? wieder von dir zu h[oö]ren[^\n.!?]*[.!?…]*\s*/giu,
    /(^|\n)\s*bentornat[oa][^\n.!?]*[.!?…]*\s*/giu,
    /(^|\n)\s*bienvenid[oa] de nuevo[^\n.!?]*[.!?…]*\s*/giu,
    /(^|\n)\s*bem-vind[oa] de volta[^\n.!?]*[.!?…]*\s*/giu,
    /(^|\n)\s*witaj ponownie[^\n.!?]*[.!?…]*\s*/giu,
    /(^|[\n.!?]\s*)[^\n.!?]*(?:are you still there|tu es toujours l[aà]|bist du noch da|sei ancora l[iì]|sigues ah[ií]|ainda est[aá]s a[ií]|jeste[sś] jeszcze)[^\n.!?]*\??\s*/giu,
  ];
  for (const pattern of multilingualForbiddenPatterns) {
    out = out.replace(pattern, "$1");
  }
  out = cleanReplyText(out);
  return out || "💚";
}

// Coaching mode: strip trailing question sentences so Emma cannot keep the
// conversation going from her side. Exceptions: a reply that is entirely one
// clarifying question, and checkout-flow content (a validated customer who
// explicitly asks to buy still gets the country/taste/Control questions).
function stripTrailingCoachingQuestions(value) {
  const text = cleanReplyText(value);
  if (!text) return text;
  if (
    CHECKOUT_SHORTLINK_PATTERN.test(text) ||
    /nederland of belgi|welke smaak|which (?:complete )?flavou?r|quel(?:le)? (?:parfum|saveur)|welche geschmacksrichtung|quale gusto|qu[eé] sabor|qual (?:é )?o sabor|kt[oó]ry smak|chocola(?:de|te)|chocolate|chocolat|schokolade|cioccolato|czekolad[ao]|vanille|vanilla|vaniglia|vainilla|baunilha|wanili[ao]|half[-\s]?(?:and[-\s]?)?half|moiti[eé][-\s]moiti[eé]|halb[-\s]halb|met[aà] e met[aà]|mitad y mitad|meio[-\s]?a[-\s]?meio|metade[-\s]?metade|p[oó][łl] na p[oó][łl]|\bcontrol\b|ordernummer|order number|num[eé]ro de commande|bestellnummer|numero d['’]ordine|n[uú]mero (?:da encomenda|do pedido|del pedido)|numer zam[oó]wienia/i.test(text)
  ) {
    return text;
  }
  const sentenceSplit = (p) =>
    (p.match(/[^.!?\n]+[.!?…]*[^\w\n.!?]*/gu) || [p]).map((s) => s.trim()).filter(Boolean);
  const paragraphs = text.split("\n\n").map((p) => p.trim()).filter(Boolean);
  const totalSentences = () =>
    paragraphs.reduce((n, p) => n + sentenceSplit(p).length, 0);
  let changed = true;
  while (changed && paragraphs.length > 0 && totalSentences() > 1) {
    changed = false;
    const sentences = sentenceSplit(paragraphs[paragraphs.length - 1]);
    const last = sentences[sentences.length - 1] || "";
    if (/\?[^\w\n]*$/u.test(last)) {
      sentences.pop();
      if (sentences.length > 0) {
        paragraphs[paragraphs.length - 1] = sentences.join(" ");
      } else {
        paragraphs.pop();
      }
      changed = true;
    }
  }
  const out = cleanReplyText(paragraphs.join("\n\n"));
  return out || text;
}

const WEBSITE_REFERENCE_REPLIES = {
  nl: "Alles over de programma's staat op de pagina die ik je eerder stuurde 💚",
  en: "Everything about the programmes is on the page I sent you earlier 💚",
  fr: "Toutes les informations sur les programmes se trouvent sur la page que je t’ai envoyée plus tôt 💚",
  de: "Alles zu den Programmen findest du auf der Seite, die ich dir vorher geschickt habe 💚",
  it: "Tutte le informazioni sui programmi sono nella pagina che ti ho inviato prima 💚",
  es: "Toda la información sobre los programas está en la página que te envié antes 💚",
  pt: "Toda a informação sobre os programas está na página que te enviei anteriormente 💚",
  pl: "Wszystkie informacje o programach znajdziesz na stronie, którą wysłałam Ci wcześniej 💚",
};

// Removes a repeated Stap 4 website/freebies block from a reply. Only
// called when the website link was already sent earlier AND the customer's
// current message does not explicitly ask for it.
function stripRepeatedWebsiteBlock(value, language = "nl") {
  const text = cleanReplyText(value);
  if (!text || !PLAIN_WEBSITE_LINK_PATTERN.test(text)) return text;
  const paragraphs = text.split("\n\n").filter((p) => {
    if (TESTIMONIALS_LINK_PATTERN.test(p) || PROGRAMMA_INFO_LINK_PATTERN.test(p)) {
      return true;
    }
    if (PLAIN_WEBSITE_LINK_PATTERN.test(p)) return false;
    if (/op deze pagina vind je|on this page you(?:'ll| will) find|sur cette page,? tu trouveras|auf dieser seite findest du|in questa pagina trovi|en esta p[aá]gina encontrar[aá]s|nesta p[aá]gina encontras|na tej stronie znajdziesz/i.test(p)) return false;
    if (/volledig gratis|completely free|enti[eè]rement gratuits?|v[oö]llig kostenlos|completamente gratuit[io]|totalmente gratis|całkowicie bezpłatn/i.test(p)) return false;
    if (/kijk welk programma je aanspreekt|see which programme appeals|regarde quel programme|schau,? welches programm|guarda quale programma|mira qu[eé] programa|v[eê] qual programa|zobacz,? kt[oó]ry program/i.test(p)) return false;
    if ((p.match(/\u{2705}/gu) || []).length >= 2) return false;
    return true;
  });
  const out = cleanReplyText(paragraphs.join("\n\n"));
  return (
    out || WEBSITE_REFERENCE_REPLIES[language] || WEBSITE_REFERENCE_REPLIES.en
  );
}

function clamp(value, max = 500) {
  const text = cleanText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max).trim()}...`;
}

function normalizeComparableText(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeBinaryFlag(value) {
  const v = cleanText(value).toLowerCase();
  if (["ja", "yes", "wel", "oui", "si", "sì", "sí", "sim", "tak", "true"].includes(v)) return "ja";
  if (["nee", "no", "niet", "non", "nein", "não", "nao", "nie", "false"].includes(v)) return "nee";
  return "";
}

function normalizeProgramName(value) {
  const v = cleanText(value).toLowerCase();
  if (v === "basic") return "Basic";
  if (v === "beauty") return "Beauty";
  if (v === "deluxe") return "Deluxe";
  if (v === "exclusive") return "Exclusive";
  return "";
}

function normalizePhaseName(value) {
  const v = cleanText(value).toLowerCase();
  const allowed = [
    "intake",
    "verdieping",
    "analyse",
    "advies",
    "commitment",
    "presentatie",
    "closing",
    "checkout-bevestiging",
    "checkout",
    "coaching",
    "na_aankoop",
  ];
  return allowed.includes(v) ? v : "";
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

function buildResponse({
  reply,
  goal_update = "",
  objections_update = "",
  last_summary_update = "",
  customer_status_update = "",
  current_phase_update = "",
  interested_in_program_update = "",
  interested_in_control_update = "",
  purchased_program_update = "",
  has_control_update = "",
  language = "",
  language_update = "",
  send_reply,
}) {
  const rawReply = reply === NO_REPLY ? NO_REPLY : cleanReplyText(reply);

  return {
    send_reply:
      typeof send_reply === "boolean" ? send_reply : rawReply !== "" && rawReply !== NO_REPLY,
    reply: rawReply,
    goal_update: cleanText(goal_update),
    objections_update: cleanText(objections_update),
    last_summary_update: cleanText(last_summary_update),
    customer_status_update: cleanText(customer_status_update),
    current_phase_update: cleanText(current_phase_update),
    interested_in_program_update: cleanText(interested_in_program_update),
    interested_in_control_update: cleanText(interested_in_control_update),
    purchased_program_update: cleanText(purchased_program_update),
    has_control_update: cleanText(has_control_update),
    language: cleanText(language),
    language_update: cleanText(language_update),
  };
}

/* ------------------------------- LANGUAGE -------------------------------- */

const SUPPORTED_LANGUAGES = ["nl", "en", "fr", "de", "it", "es", "pt", "pl"];

const LANGUAGE_NAMES = {
  nl: "Nederlands",
  en: "English",
  fr: "French",
  de: "German",
  it: "Italian",
  es: "Spanish",
  pt: "Portuguese (Portugal)",
  pl: "Polish",
};

// Country calling code -> language. Checked longest-prefix-first so "1"
// (US/Canada) cannot shadow longer codes. Belgium (32) defaults to Dutch;
// French-speaking Belgians are fixed by the early text-based switch.
const PHONE_PREFIX_LANGUAGE = {
  "31": "nl",
  "32": "nl",
  "33": "fr",
  "49": "de",
  "43": "de",
  "41": "de",
  "39": "it",
  "34": "es",
  "351": "pt",
  "48": "pl",
  "44": "en",
  "353": "en",
  "61": "en",
  "64": "en",
  "1": "en",
};

const FRANC_TO_LANGUAGE = {
  nld: "nl",
  eng: "en",
  fra: "fr",
  deu: "de",
  ita: "it",
  spa: "es",
  por: "pt",
  pol: "pl",
};

function normalizeLanguage(value) {
  const v = cleanText(value).toLowerCase();
  return SUPPORTED_LANGUAGES.includes(v) ? v : "";
}

function detectLanguageFromPhone(userId) {
  const value = cleanText(userId).replace(/^\+/, "");
  // Only trust the country prefix when the id actually looks like a phone
  // number in international format: digits only, 10-15 characters. WhatsApp
  // BSUIDs (username rollout, 2026) can contain digits too and must never be
  // read as a country code.
  if (!/^[0-9]{10,15}$/.test(value)) return "";
  for (const len of [3, 2, 1]) {
    const prefix = value.slice(0, len);
    if (PHONE_PREFIX_LANGUAGE[prefix]) return PHONE_PREFIX_LANGUAGE[prefix];
  }
  return "";
}

// Explicit language requests ("can we speak English?", "auf Deutsch bitte").
// Deterministic patterns, one per supported language. Unlike statistical text
// detection these work on short sentences and at ANY point in the
// conversation: an explicit request always wins and re-locks the language.
const EXPLICIT_LANGUAGE_REQUEST_PATTERNS = [
  {
    language: "en",
    pattern:
      /\b(in english|speak english|english,? please|switch to english|continue in english|i don.?t speak dutch|i do not speak dutch|do you speak english)\b/i,
  },
  {
    language: "nl",
    pattern:
      /\b(in het nederlands|nederlands,? graag|spreek je nederlands|verder in het nederlands)\b/i,
  },
  {
    language: "fr",
    pattern:
      /\b(en fran[cç]ais|fran[cç]ais,? s.?il vous pla[iî]t|je ne parle pas n[eé]erlandais|parlez.?vous fran[cç]ais|continuer en fran[cç]ais)\b/i,
  },
  {
    language: "de",
    pattern:
      /\b(auf deutsch|deutsch,? bitte|ich spreche kein niederl[aä]ndisch|sprechen sie deutsch|sprichst du deutsch|weiter auf deutsch)\b/i,
  },
  {
    language: "it",
    pattern:
      /\b(in italiano|italiano,? per favore|non parlo olandese|parli italiano|continuare in italiano)\b/i,
  },
  {
    language: "es",
    pattern:
      /\b(en espa[nñ]ol|espa[nñ]ol,? por favor|no hablo (holand[eé]s|neerland[eé]s)|hablas espa[nñ]ol|continuar en espa[nñ]ol)\b/i,
  },
  {
    language: "pt",
    pattern:
      /\b(em portugu[eê]s|portugu[eê]s,? por favor|n[aã]o falo (holand[eê]s|neerland[eê]s)|falas portugu[eê]s|podemos falar (?:em )?portugu[eê]s|continuar em portugu[eê]s)\b/i,
  },
  {
    language: "pl",
    pattern:
      /\b(po polsku|nie m[oó]wi[eę] po (holendersku|niderlandzku)|m[oó]wisz po polsku)\b/i,
  },
];

function detectExplicitLanguageRequest(text) {
  const value = cleanText(text);
  if (!value) return "";
  for (const { language, pattern } of EXPLICIT_LANGUAGE_REQUEST_PATTERNS) {
    if (pattern.test(value)) return language;
  }
  return "";
}

// Country calling code -> customer country for PRICING. The checkout links
// are universal; this only determines which price table row Emma quotes.
// Unknown prefix / BSUID stays UNKNOWN; the prompt uses pound prices as its
// display fallback without pretending the customer is in the UK.
const PHONE_PREFIX_COUNTRY = {
  "31": "NL",
  "32": "BE",
  "33": "FR",
  "34": "ES",
  "39": "IT",
  "44": "UK",
  "48": "PL",
  "49": "DE",
  "351": "PT",
};

function detectCountryFromPhone(userId) {
  const value = cleanText(userId).replace(/^\+/, "");
  if (!/^[0-9]{10,15}$/.test(value)) return "";
  for (const len of [3, 2, 1]) {
    const prefix = value.slice(0, len);
    if (PHONE_PREFIX_COUNTRY[prefix]) return PHONE_PREFIX_COUNTRY[prefix];
  }
  return "";
}

// Returns one of SUPPORTED_LANGUAGES, "other" (confidently detected but not a
// supported language), or "" (too short / undetermined).
function detectLanguageFromText(text) {
  const value = cleanText(text);
  if (value.length < LANGUAGE_TEXT_MIN_CHARS) return "";
  const iso3 = franc(value, { minLength: LANGUAGE_TEXT_MIN_CHARS });
  if (!iso3 || iso3 === "und") return "";
  return FRANC_TO_LANGUAGE[iso3] || "other";
}

// Belgium has two supported conversation languages while its phone prefix can
// supply only one default. Confident text detection therefore outranks the +32
// default. A few unmistakable short greetings cover the first-message cases
// that are too short for franc-min; this affects language only, never market.
function detectBelgianLanguageFromText(text) {
  const detected = detectLanguageFromText(text);
  if (detected === "fr" || detected === "nl") return detected;

  const value = cleanText(text).toLowerCase();
  if (/^(?:bonjour|bonsoir|coucou|salut)(?:\b|[!,.])/i.test(value)) return "fr";
  if (/^(?:hallo|hoi|goedemorgen|goedemiddag|goedenavond)(?:\b|[!,.])/i.test(value)) {
    return "nl";
  }
  return "";
}

// Before Portuguese was supported, +351 contacts could be stored as English
// (unsupported-language fallback) or Dutch (short-message fallback). Repair
// only those legacy defaults when a Portuguese-market customer is now
// confidently writing Portuguese. Explicit language requests still win.
function shouldMigrateLegacyPortugueseLanguage({
  storedLanguage,
  customerCountry,
  explicitRequest,
  textLanguage,
}) {
  return (
    customerCountry === "PT" &&
    ["en", "nl"].includes(storedLanguage) &&
    !explicitRequest &&
    textLanguage === "pt"
  );
}


/* -------------------------- MESSAGE NORMALIZATION ------------------------- */

function normalizeRole(role) {
  const r = cleanText(role).toLowerCase();

  if (["emma", "assistant", "ai", "agent", "bot"].includes(r)) return "emma";

  if (["user", "customer", "klant", "client", "lead", "persoon"].includes(r)) {
    return "user";
  }

  return r || "unknown";
}

function parseTimestamp(value) {
  const raw = cleanText(value);
  if (!raw) return null;

  if (/^\d{10}$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }

  if (/^\d{13}$/.test(raw)) {
    const milliseconds = Number(raw);
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }

  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

function normalizeRecentMessages(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((item, index) => {
      const role = normalizeRole(item?.role || item?.sender || item?.from);
      const message_text = cleanText(
        item?.message_text || item?.message || item?.text || item?.content
      );
      const timestamp = cleanText(
        item?.timestamp || item?.created_at || item?.date || item?.time
      );

      return {
        role,
        message_text,
        timestamp,
        _index: index,
        _time: parseTimestamp(timestamp),
      };
    })
    .filter((item) => item.role || item.message_text || item.timestamp);
}

function sortMessagesChronologically(messages) {
  return [...messages].sort((a, b) => {
    if (a._time !== null && b._time !== null) return a._time - b._time;
    if (a._time !== null) return -1;
    if (b._time !== null) return 1;
    return a._index - b._index;
  });
}

function removeCurrentUserMessageFromHistory(messages, currentMessage) {
  const current = normalizeComparableText(currentMessage);
  if (!current) return messages;

  let removed = false;

  return [...messages]
    .reverse()
    .filter((msg) => {
      if (removed) return true;

      const sameRole = msg.role === "user";
      const sameText = normalizeComparableText(msg.message_text) === current;

      if (sameRole && sameText) {
        removed = true;
        return false;
      }

      return true;
    })
    .reverse();
}

function sanitizeAndPrepareRecentMessages(recentMessages, currentMessage) {
  const normalized = normalizeRecentMessages(recentMessages);
  const sorted = sortMessagesChronologically(normalized);

  const deduped = uniqueBy(sorted, (msg) => {
    const role = msg.role || "unknown";
    const text = normalizeComparableText(msg.message_text);
    const time = msg.timestamp || "";
    return `${role}|${text}|${time}`;
  });

  const withoutCurrentMessage = removeCurrentUserMessageFromHistory(
    deduped,
    currentMessage
  );

  const withText = withoutCurrentMessage.filter((msg) => msg.message_text);
  const recentWindow = withText.slice(-MAX_CONTEXT_MESSAGES);
  // Keep critical one-time link messages even when a long conversation has
  // pushed them outside the normal context window. The checkout link encodes
  // the complete selection baseline; the testimonials link must remain visible
  // so it can never be sent as a first-time link twice.
  const latestCheckoutMessage = [...withText]
    .reverse()
    .find((msg) => msg.role === "emma" && hasCheckoutLinkBeenSent([msg]));
  const latestTestimonialsMessage = [...withText]
    .reverse()
    .find(
      (msg) =>
        msg.role === "emma" &&
        hasPatternBeenSent([msg], TESTIMONIALS_LINK_PATTERN)
    );
  const latestStep2ChecklistMessage = [...withText]
    .reverse()
    .find(
      (msg) =>
        msg.role === "emma" &&
        messageLooksLikeStep2Checklist(msg.message_text)
    );
  const missingPinnedMessages = [
    latestStep2ChecklistMessage,
    latestCheckoutMessage,
    latestTestimonialsMessage,
  ]
    .filter(Boolean)
    .filter((msg) => !recentWindow.includes(msg))
    .sort((a, b) => withText.indexOf(a) - withText.indexOf(b));
  const contextWindow = [...missingPinnedMessages, ...recentWindow];

  return contextWindow
    .map((msg) => ({
      role: msg.role || "unknown",
      message_text: clamp(msg.message_text, MAX_MESSAGE_CHARS),
      timestamp: msg.timestamp || "",
    }));
}

/* -------------------- CONTEXTUAL CONVERSATION PAUSES -------------------- */

// These checks protect conversation structure only. They deliberately do not
// try to understand customer wording; semantic meaning remains the job of the
// multilingual classifier.
function messageLooksLikeStep2Checklist(value) {
  const text = String(value || "");
  if (!text.includes("✅")) return false;

  // Programme, freebies and checkout blocks can also contain check marks.
  // A Step 2 intake checklist never contains one of these links.
  return !/(?:nutritionworks\.online|tr\.ee\/|chat\.whatsapp\.com)/i.test(text);
}

function hasStep2ChecklistBeenSent(messages) {
  return (Array.isArray(messages) ? messages : []).some(
    (msg) =>
      msg?.role === "emma" && messageLooksLikeStep2Checklist(msg.message_text)
  );
}

function isKnownWelcomeMessage(value) {
  const message = normalizeComparableText(value);
  if (!message) return false;

  return [
    ...Object.values(WELCOME_MESSAGES),
    ...Object.values(FRANCE_WELCOME_MESSAGES),
  ].some((welcome) => {
    const known = normalizeComparableText(welcome);
    // Recent messages may have been clamped to MAX_MESSAGE_CHARS.
    return (
      message === known || known.startsWith(message) || message.startsWith(known)
    );
  });
}

function countNaturalIntakeFollowUps(messages) {
  return (Array.isArray(messages) ? messages : []).filter((msg) => {
    if (msg?.role !== "emma") return false;
    const text = String(msg.message_text || "");
    if (!text.includes("?")) return false;
    if (isKnownWelcomeMessage(text) || messageLooksLikeStep2Checklist(text)) {
      return false;
    }
    return !/(?:nutritionworks\.online|tr\.ee\/|chat\.whatsapp\.com)/i.test(text);
  }).length;
}

function countPostChecklistClarifications(messages) {
  const items = Array.isArray(messages) ? messages : [];
  let lastChecklistIndex = -1;

  items.forEach((msg, index) => {
    if (
      msg?.role === "emma" &&
      messageLooksLikeStep2Checklist(msg.message_text)
    ) {
      lastChecklistIndex = index;
    }
  });

  if (lastChecklistIndex < 0) return 0;
  return items.slice(lastChecklistIndex + 1).filter((msg) => {
    if (msg?.role !== "emma") return false;
    const text = String(msg.message_text || "");
    return (
      text.includes("?") &&
      !/(?:nutritionworks\.online|tr\.ee\/|chat\.whatsapp\.com)/i.test(text)
    );
  }).length;
}

// INTAKE PURE LOGIC START
function decideIntakeAction({
  classification,
// The server supplies only observable intake milestones. Emma remains
// responsible for understanding the customer's meaning and writing the next
// conversational turn.
function buildStructuralIntakeTurnGuard({
  recentMessages,
  validatedCustomer = false,
}) {
  if (validatedCustomer) {
    return { action: "normal", testimonials_allowed: false };
  }
  if (validatedCustomer) return "";
  if (hasPatternBeenSent(recentMessages, TESTIMONIALS_LINK_PATTERN)) return "";

  const confidence = cleanText(classification?.intake_confidence);
  const trusted = confidence === "high" || confidence === "medium";
  const directRequest =
    classification?.direct_testimonials_request === true && trusted;
  const testimonialsAlreadySent = hasPatternBeenSent(
    recentMessages,
    TESTIMONIALS_LINK_PATTERN
  );
  const serverChecklistDetected = hasStep2ChecklistBeenSent(recentMessages);
  const checklistSent = hasStep2ChecklistBeenSent(recentMessages);
  const responseType = cleanText(classification?.checklist_response_type);
  const checklistSent =
    classification?.checklist_sent === true || serverChecklistDetected;
  const followUpsAsked = countNaturalIntakeFollowUps(recentMessages);
  const postChecklistClarifications =
    countPostChecklistClarifications(recentMessages);
  const clarificationsAsked = countPostChecklistClarifications(recentMessages);

  if (testimonialsAlreadySent) {
    return directRequest
      ? { action: "allow_testimonials_resend", testimonials_allowed: true }
      : { action: "testimonials_already_sent", testimonials_allowed: false };
  if (!checklistSent && followUpsAsked >= 2) {
    return [
      "TECHNISCH INTAKEMOMENT: vóór de verplichte Stap 2-checklist zijn al twee natuurlijke vervolgvragen gesteld.",
      "Stel nu geen derde losse intakevraag. Schrijf zelf een warme, contextuele reactie en stuur het eenmalige adaptieve checklistbericht volgens Stap 2.",
      "Verwijder onderwerpen die de klant al heeft genoemd en doe niet alsof je meer weet dan werkelijk is gedeeld.",
    ].join("\n");
  }

  // A structurally confirmed checklist is a stronger fact than an uncertain
  // secondary classifier result. After that one-time milestone, uncertainty
  // must never collapse the conversation into the generic hold reply. Let the
  // primary conversational agent apply the semantic prompt rules instead.
  if (!trusted && serverChecklistDetected) {
    return {
      action: "contextual_after_checklist",
      testimonials_allowed: true,
    };
  }

  if (!trusted) {
    return { action: "hold_uncertain", testimonials_allowed: false };
  }

  if (classification?.intake_context_active !== true) {
    if (serverChecklistDetected) {
      return {
        action: "contextual_after_checklist",
        testimonials_allowed: true,
      };
    }
    return { action: "normal", testimonials_allowed: false };
  }

  // Once the checklist has been sent, goal and challenge are no longer hard
  // gates. The customer's answer to that checklist decides whether intake is
  // complete. This prevents a second checklist or a new formal challenge
  // question after the customer has already completed the moment naturally.
  if (checklistSent) {
    if (
      responseType === "meaningful_details" ||
      responseType === "explicit_no_more" ||
      responseType === "cannot_elaborate"
    ) {
      return { action: "allow_testimonials", testimonials_allowed: true };
    }

    if (responseType === "question_or_objection") {
      return { action: "answer_and_hold", testimonials_allowed: false };
    }

    if (responseType === "bare_acknowledgement") {
      // One organic clarification is enough. A second non-substantive answer
      // is respected as the end of intake instead of creating a loop.
      return postChecklistClarifications >= 1
        ? { action: "allow_testimonials", testimonials_allowed: true }
        : { action: "clarify_checklist", testimonials_allowed: false };
    }

    // The checklist is known to have been sent, but the secondary classifier
    // supplied no usable semantic label. Deferring to Emma is safer and more
    // natural than replacing her answer with a dead-end thank-you message.
    return {
      action: "contextual_after_checklist",
      testimonials_allowed: true,
    };
    return [
      "TECHNISCH INTAKEMOMENT: het verplichte Stap 2-checklistbericht is aantoonbaar al één keer verstuurd.",
      "Herhaal de checklist nooit en stel niet alsnog een formele doel- of uitdagingsvraag.",
      "Begrijp het nieuwste bericht zelf contextueel vanuit het volledige gesprek: inhoudelijke informatie, herkenning, niets meer willen of kunnen toevoegen, een vraag, een bezwaar en een losse bevestiging zijn verschillende situaties.",
      "Volg daarvoor de organische Stap 2- en Stap 3-regels uit de prompt. De server bepaalt de betekenis niet en schrijft het antwoord niet voor.",
      clarificationsAsked >= 1
        ? "Er is na de checklist al een verduidelijkingsvraag gesteld. Stel geen tweede verduidelijkingsvraag; respecteer het antwoord en ga organisch verder."
        : "Alleen als het werkelijk een inhoudsloze bevestiging is, mag je maximaal één natuurlijke verduidelijkingsvraag stellen.",
    ].join("\n");
  }

  if (responseType === "question_or_objection") {
    return { action: "answer_and_hold", testimonials_allowed: false };
  }

  // When the customer cannot or does not want to explain the missing context,
  // the mandatory checklist becomes a gentle discovery aid instead of an
  // interrogation.
  if (responseType === "cannot_elaborate") {
    return { action: "send_checklist_support", testimonials_allowed: false };
  }

  // Never ask a third intake follow-up. Rich information can reach the
  // checklist sooner; sparse information reaches it after at most two turns.
  if (
    followUpsAsked >= 2 ||
    (classification?.goal_context_clear === true &&
      classification?.challenge_context_clear === true)
  ) {
    return { action: "send_checklist", testimonials_allowed: false };
  }

  if (classification?.goal_context_clear !== true) {
    return { action: "ask_goal", testimonials_allowed: false };
  }

  if (classification?.challenge_context_clear !== true) {
    return { action: "ask_challenge", testimonials_allowed: false };
  }

  return { action: "send_checklist", testimonials_allowed: false };
  return "";
}
// INTAKE PURE LOGIC END


// PAUSE PURE LOGIC START
function getPauseAnchorTimestampMs(classification, recentMessages) {
  const anchorId = cleanText(classification?.pause_anchor_id);
  const match = anchorId.match(/^history_(\d+)$/);
  if (!match) return null;

  const classifierHistory = recentMessages.slice(-20);
  const index = Number(match[1]) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= classifierHistory.length) {
    return null;
  }

  return parseTimestamp(classifierHistory[index]?.timestamp);
}

function decidePauseAction(classification, recentMessages, nowMs = Date.now()) {
  const anchorTimestampMs = getPauseAnchorTimestampMs(
    classification,
    recentMessages
  );
  const elapsedMs = Number.isFinite(anchorTimestampMs)
    ? Math.max(0, nowMs - anchorTimestampMs)
    : null;
  const minimumResumeMs = Number.isFinite(PAUSE_MIN_RESUME_MS)
    ? Math.max(0, PAUSE_MIN_RESUME_MS)
    : 30 * 60 * 1000;
  const withinMinimum = elapsedMs === null || elapsedMs < minimumResumeMs;
  const pauseActive = classification?.pause_context_active === true;
  const explicitAnchor = classification?.pause_anchor_is_explicit === true;
  const messageType = cleanText(classification?.current_message_type);
  const confidence = cleanText(classification?.confidence);
  const trusted = confidence === "high" || confidence === "medium";
  const heartTrusted = confidence === "high";
  const anchorMatch = cleanText(classification?.pause_anchor_id).match(
    /^history_(\d+)$/
  );
  const anchorIndex = anchorMatch ? Number(anchorMatch[1]) - 1 : -1;
  const pauseAnchorIdentified =
    Number.isInteger(anchorIndex) &&
    anchorIndex >= 0 &&
    anchorIndex < recentMessages.slice(-20).length;

  let action = "normal_reply";
  if (
    pauseActive &&
    heartTrusted &&
    explicitAnchor &&
    pauseAnchorIdentified &&
    elapsedMs !== null &&
    messageType === "closing_acknowledgement"
  ) {
    // Time alone never turns a closing acknowledgement into a resumed
    // conversation. A green heart is correct both before and after 30 minutes.
    action = "heart_only";
  } else if (
    trusted &&
    explicitAnchor &&
    pauseAnchorIdentified &&
    withinMinimum &&
    (messageType === "substantive" || messageType === "other")
  ) {
    // Real content is answered, but inside the first 30 minutes Emma may not
    // restart or advance the sales flow on her own.
    action = "guarded_reply";
  }

  return {
    action,
    elapsed_ms: elapsedMs,
    within_minimum: withinMinimum,
    timestamps_available: elapsedMs !== null,
    pause_anchor_identified: pauseAnchorIdentified,
    pause_anchor_is_explicit: explicitAnchor,
  };
}
// PAUSE PURE LOGIC END

function getLastEmmaMessages(messages, limit = 3) {
  return messages
    .filter((msg) => msg.role === "emma" && msg.message_text)
    .slice(-limit)
    .map((msg) => msg.message_text);
}

function getLastUserMessages(messages, limit = 3) {
  return messages
    .filter((msg) => msg.role === "user" && msg.message_text)
    .slice(-limit)
    .map((msg) => msg.message_text);
}

function hasPriceBeenMentioned(messages) {
  // Currency notation is the strongest language-independent signal. The
  // translated phrases cover answers that describe a price without a symbol.
  const priceRegex =
    /€\s*\d|£\s*\d|\d\s*zł|\d+\s*(?:euro|euros|eur|pounds?)\b|programma kost|kost in totaal|totaalprijs|programme costs?|total price|prix (?:total|du programme)|co[uû]te|gesamtpreis|kostet insgesamt|prezzo totale|costa in totale|precio total|cuesta en total|preço total|custa no total|cena całkowita|kosztuje łącznie/i;
  return messages.some(
    (msg) => msg.role === "emma" && priceRegex.test(msg.message_text)
  );
}

const CHECKOUT_SHORTLINK_PATTERN =
  /\btr\.ee\/(?:bestellen-(?:nl|be)-[a-z0-9-]+|(?:basic|beauty|deluxe|exclusive)-(?:van|choc|mix)(?:-control)?|control1x|(?:basic|beauty|deluxe|exclusive)-(?:van|choc|mixte|mix)(?:-control)?-4x-fr|control-4x-fr|[a-z0-9-]+-4x-fr|berries|fruit-vegtables|fruit-veg-berry|essentials-omega|omegaselection|berries-omega|superfood|fruit-veg-berry-soft|fruit-veg-soft|berries-soft)(?:\b|\/|\?|$)/i;

function hasCheckoutLinkBeenSent(messages) {
  return messages.some(
    (msg) =>
      msg.role === "emma" &&
      CHECKOUT_SHORTLINK_PATTERN.test(msg.message_text)
  );
}

function hasWhatsappGroupLinkBeenSent(messages) {
  return messages.some(
    (msg) =>
      msg.role === "emma" &&
      /chat\.whatsapp\.com/i.test(msg.message_text)
  );
}

function hasAskedOrderNumber(messages) {
  return messages.some(
    (msg) =>
      msg.role === "emma" &&
      /ordernummer|order number|num[eé]ro (?:de commande|d['’]ordine|del pedido)|bestellnummer|n[uú]mero (?:da encomenda|do pedido)|numer zam[oó]wienia/i.test(
        msg.message_text
      )
  );
}

function hasAskedTaste(messages) {
  return messages.some(
    (msg) =>
      msg.role === "emma" &&
      /welke smaak|which (?:complete )?flavou?r|quel(?:le)? (?:parfum|saveur)|welche (?:complete[-\s]?)?geschmacksrichtung|quale gusto|qu[eé] sabor|qual (?:é )?o sabor|kt[oó]ry smak|smaak complete|sabor (?:do |da )?complete|(?:chocola(?:de|te)|chocolate|chocolat|schokolade|cioccolato|czekolad[ao]).{0,80}(?:vanille|vanilla|vaniglia|vainilla|baunilha|wanili[ao])|(?:vanille|vanilla|vaniglia|vainilla|baunilha|wanili[ao]).{0,80}(?:chocola(?:de|te)|chocolate|chocolat|schokolade|cioccolato|czekolad[ao])/i.test(
        msg.message_text
      )
  );
}

function normalizeTasteChoice(text) {
  const value = cleanText(text).toLowerCase();
  if (!value) return "";
  if (/\b(chocolade|chocolate|chocolat|schokolade|cioccolato|czekolada|czekoladowy)\b/i.test(value)) {
    return "chocolate";
  }
  if (/\b(vanille|vanilla|vaniglia|vainilla|baunilha|wanilia|waniliowy)\b/i.test(value)) {
    return "vanilla";
  }
  if (
    /\b(half[-\s]?(?:and[-\s]?)?half|mix|mixed|gemengd|moiti[eé][-\s]moiti[eé]|halb[-\s]halb|met[aà]\s+e\s+met[aà]|mitad\s+y\s+mitad|meio[-\s]a[-\s]meio|metade[-\s]metade|misto|mistura|p[oó][łl]\s+na\s+p[oó][łl])\b/i.test(
      value
    )
  ) {
    return "mix";
  }
  return "";
}

function hasReceivedTasteAnswer(messages) {
  return messages.some(
    (msg) => msg.role === "user" && Boolean(normalizeTasteChoice(msg.message_text))
  );
}

function isTasteOnlyCheckoutAnswer(text) {
  const normalized = cleanText(text).toLowerCase();
  if (!normalized) return false;

  // Only intercept short answers whose actual content is the taste choice.
  // Longer messages or questions about Control remain available to Emma so she
  // can answer them naturally before asking for the final yes/no choice.
  return /^\s*(?:(?:graag|please|s['’]il te pla[iî]t|bitte|per favore|por favor|prosz[eę])\s+)?(?:chocolade|chocolate|chocolat|schokolade|cioccolato|czekolada|czekoladowy|vanille|vanilla|vaniglia|vainilla|baunilha|wanilia|waniliowy|half[-\s]?(?:and[-\s]?)?half|mix|mixed|gemengd|moiti[eé][-\s]moiti[eé]|halb[-\s]halb|met[aà]\s+e\s+met[aà]|mitad\s+y\s+mitad|meio[-\s]a[-\s]meio|metade[-\s]metade|misto|mistura|p[oó][łl]\s+na\s+p[oó][łl])(?:\s+(?:graag|please|bitte|per favore|por favor|prosz[eę]))?\s*[.!]?\s*$/i.test(
    normalized
  );
}

function controlFollowUpForLanguage(language, tasteText) {
  const taste = cleanText(tasteText).toLowerCase();
  const labels = {
    nl: { chocolate: "chocolade", vanilla: "vanille", mix: "half-half" },
    en: { chocolate: "chocolate", vanilla: "vanilla", mix: "half-and-half" },
    fr: { chocolate: "chocolat", vanilla: "vanille", mix: "moitié-moitié" },
    de: { chocolate: "Schokolade", vanilla: "Vanille", mix: "halb-halb" },
    it: { chocolate: "cioccolato", vanilla: "vaniglia", mix: "metà e metà" },
    es: { chocolate: "chocolate", vanilla: "vainilla", mix: "mitad y mitad" },
    pt: { chocolate: "chocolate", vanilla: "baunilha", mix: "meio a meio" },
    pl: { chocolate: "czekolada", vanilla: "wanilia", mix: "pół na pół" },
  };

  const key = normalizeTasteChoice(taste) || "vanilla";
  const lang = labels[language] ? language : "en";
  const label = labels[lang][key];

  const messages = {
    nl: `Helder, ${label} genoteerd 💚\n\nWil je Control erbij doen? 😊`,
    en: `Got it, ${label} noted 💚\n\nWould you like to add Control? 😊`,
    fr: `Parfait, ${label} noté 💚\n\nSouhaites-tu ajouter Control ? 😊`,
    de: `Alles klar, ${label} ist notiert 💚\n\nMöchtest du Control dazu nehmen? 😊`,
    it: `Perfetto, ${label} segnato 💚\n\nVuoi aggiungere Control? 😊`,
    es: `Perfecto, ${label} anotado 💚\n\n¿Quieres añadir Control? 😊`,
    pt: `Perfeito, ${label} registado 💚\n\nQueres adicionar Control? 😊`,
    pl: `Jasne, zapisuję ${label} 💚\n\nCzy chcesz dodać Control? 😊`,
  };

  return messages[lang];
}

// Detects a Control answer in every supported conversation language. This is
// a deterministic safety net around the semantic checkout classifier.
function hasReceivedControlAnswer(messages) {
  const emmaControlQuestionPattern =
    /(?:wil je|zou je|would you|do you want|souhaites-tu|veux-tu|m[oö]chtest du|willst du|vuoi|quieres|queres|czy chcesz).{0,80}\bcontrol\b|\bcontrol\b.{0,80}(?:erbij|toevoegen|add|ajouter|hinzuf[uü]gen|dazu|aggiungere|a[nñ]adir|adicionar|doda[cć]|\?)/i;
  let lastEmmaIndexWithControlAsk = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg.role === "emma" &&
      emmaControlQuestionPattern.test(msg.message_text || "")
    ) {
      lastEmmaIndexWithControlAsk = i;
      break;
    }
  }

  // Check user messages AFTER Emma's Control question for an answer
  const userMessagesAfterAsk =
    lastEmmaIndexWithControlAsk >= 0
      ? messages.slice(lastEmmaIndexWithControlAsk + 1)
      : messages;

  return userMessagesAfterAsk.some((msg) => {
    if (msg.role !== "user") return false;
    const text = (msg.message_text || "").toLowerCase();

    const yesWords =
      /\b(ja|jazeker|graag|prima|zeker|doe maar|inderdaad|natuurlijk|yes|yeah|sure|please|oui|d['’]accord|bien s[uû]r|si|s[iíì]|certo|claro|sim|tak|dobrze|oczywi[sś]cie)\b/i;
    const noWords =
      /\b(nee|geen|zonder|liever niet|laat maar|niet|no|nope|without|non|sans|nein|ohne|senza|sin|n[aã]o|sem|nie|bez)\b/i;
    if (/\bcontrol\b/i.test(text) && (yesWords.test(text) || noWords.test(text))) {
      return true;
    }

    // Standalone yes/no when Emma's last question contained Control
    if (lastEmmaIndexWithControlAsk >= 0) {
      if (
        /^\s*(?:ja|jazeker|graag|prima|doe\s*maa?r[ts]?|inderdaad|natuurlijk|zeker|ok[eé]?|jep|yes|yeah|sure|please|oui|d['’]accord|bien s[uû]r|si|s[iíì]|certo|claro|sim|tak|dobrze|oczywi[sś]cie)(?:\s+(?:graag|please|zeker|prima|doe\s*maa?r[ts]?|natuurlijk|sure|por favor))?\s*[\.!]?\s*$/i.test(
          text
        )
      )
        return true;
      if (
        /^\s*(?:nee|nope|geen|niks|no|non|nein|n[aã]o|nie)(?:,?\s*(?:dank\s*je(?:\s*wel)?|bedankt|thanks?|thank you|merci|danke|grazie|gracias|obrigad[oa]|dzi[eę]kuj[eę]|laat\s+maar|hoor|joh|por favor))?\s*[\.!]?\s*$/i.test(
          text
        )
      )
        return true;
    }

    return false;
  });
}

function isCustomerStatusValidated(customerStatus, recentMessages) {
  return (
    cleanText(customerStatus).toLowerCase() === "customer" ||
    hasWhatsappGroupLinkBeenSent(recentMessages)
  );
}

/* ---------------------- PRODUCT FIELD DERIVATION ------------------------- */
// Internal product detection (deterministic, code-side).
// Triggers when a valid order number has been shared AND a WhatsApp group
// link has been sent — same gate as customer_status validation.
// Once triggered, derives purchased_program, has_control, interested_in_program
// and interested_in_control from the conversation content.
// Once triggered, derives only the verified purchase fields. Program interest
// and doubt are semantic conversation facts and stay with the AI extractor.

// Juice Plus order numbers always start with "JP04", followed by a
// customer-specific code. "JP04" alone is not enough: require at least
// three extra characters after the prefix.
const ORDER_NUMBER_PATTERN = /\bJP04[-_]?[A-Z0-9]{3,}\b/i;
const PROGRAM_PATTERN = /\b(basic|beauty|deluxe|exclusive)\b/i;
const PROGRAM_PATTERN_GLOBAL = /\b(basic|beauty|deluxe|exclusive)\b/gi;
const CONTROL_MENTION_PATTERN = /\bcontrol\b/i;
const CONTROL_COMBO_PATTERN =
  /(?:\bmet[\s-]*(?:de[\s-]*)?control|\ben[\s-]*(?:de[\s-]*)?control|\binclusief[\s-]*control|\bcontrol[\s-]*erbij|\bwith[\s-]*control|\bavec[\s-]*control|\bmit[\s-]*control|\bcon[\s-]*control|\bcom[\s-]*control|\bz[\s-]*control|\binclu(?:ding|s|ant|so|ido)[\s-]*control|(?:^|\s|\W)\+[\s-]*control)/i;

// Parses a tr.ee checkout URL and extracts the SKU components:
// program (Basic/Beauty/Deluxe/Exclusive or empty for Control-only) and
// whether Control is included. The URL contains the canonical truth about
// what the customer was actually directed to buy, which is more reliable
// than parsing Emma's natural-language confirmation text.
function parseCheckoutLinkSKU(url) {
  if (!url) return null;

  // France 4-instalment links (2026): tr.ee/basic-van-4x-fr,
  // tr.ee/beauty-mixte-control-4x-fr, tr.ee/basic-mix-control-4x-fr, ...
  // Note the taste token is "mixte" everywhere EXCEPT Basic+Control, which
  // uses "mix". Both spellings are accepted here, and "mixte" is listed before
  // "mix" so the longer token wins.
  //
  // This branch MUST run before the universal branch below. The universal
  // pattern would otherwise match the "beauty-mix" prefix of
  // "beauty-mixte-control-4x-fr", fail to see the "-control" that follows
  // "mixte", and return hasControl=false for a combo order.
  const franceMatch = url.match(
    /tr\.ee\/(basic|beauty|deluxe|exclusive)-(van|choc|mixte|mix)(-control)?-4x-fr/i
  );
  if (franceMatch) {
    const lower = franceMatch[1].toLowerCase();
    const program = lower.charAt(0).toUpperCase() + lower.slice(1);
    const taste = franceMatch[2].toLowerCase() === "van"
      ? "vanilla"
      : franceMatch[2].toLowerCase() === "choc"
        ? "chocolate"
        : "mix";
    const hasControl = Boolean(franceMatch[3]);
    return { program, taste, hasControl, paymentMode: "france_4x" };
  }
  if (/tr\.ee\/control-4x-fr(?:\b|\/|\?|$)/i.test(url)) {
    return {
      program: "",
      taste: "not_required",
      hasControl: true,
      paymentMode: "france_4x",
    };
  }

  // Universal links (2026): tr.ee/Basic-Van, tr.ee/Deluxe-Mix-Control, ...
  const universalMatch = url.match(
    /tr\.ee\/(basic|beauty|deluxe|exclusive)-(van|choc|mix)(-control)?/i
  );
  if (universalMatch) {
    const lower = universalMatch[1].toLowerCase();
    const program = lower.charAt(0).toUpperCase() + lower.slice(1);
    const taste = universalMatch[2].toLowerCase() === "van"
      ? "vanilla"
      : universalMatch[2].toLowerCase() === "choc"
        ? "chocolate"
        : "mix";
    const hasControl = Boolean(universalMatch[3]);
    return { program, taste, hasControl, paymentMode: "one_time" };
  }
  if (/tr\.ee\/control1x(?:\b|\/|\?|$)/i.test(url)) {
    return {
      program: "",
      taste: "not_required",
      hasControl: true,
      paymentMode: "one_time",
    };
  }

  // Legacy country links, kept so running conversations still validate.
  const programMatch = url.match(
    /tr\.ee\/bestellen-(?:nl|be)-(basic|beauty|deluxe|exclusive)(?:-(choc|van|mix))?(-control)?/i
  );
  if (programMatch) {
    const lower = programMatch[1].toLowerCase();
    const program = lower.charAt(0).toUpperCase() + lower.slice(1);
    const taste = programMatch[2]?.toLowerCase() === "van"
      ? "vanilla"
      : programMatch[2]?.toLowerCase() === "choc"
        ? "chocolate"
        : programMatch[2]?.toLowerCase() === "mix"
          ? "mix"
          : "";
    const hasControl = Boolean(programMatch[3]);
    return { program, taste, hasControl, paymentMode: "one_time" };
  }
  if (/tr\.ee\/bestellen-(?:nl|be)-control(?:\b|\/|\?|$)/i.test(url)) {
    return {
      program: "",
      taste: "not_required",
      hasControl: true,
      paymentMode: "one_time",
    };
  }

  return null;
}

// Walks backward through Emma's messages to find the most recent tr.ee
// checkout URL she sent. Prefers the current reply if it contains a link.
function findLastEmmaCheckoutLink(messages, currentReply) {
  // The France alternative is listed FIRST so that a "-4x-fr" link is matched
  // in full. Otherwise the universal alternative would match its "basic-van"
  // prefix and silently drop the "-control" that follows "mixte".
  const urlRegex =
    /(https?:\/\/tr\.ee\/(?:(?:basic|beauty|deluxe|exclusive)-(?:van|choc|mixte|mix)(?:-control)?-4x-fr|control-4x-fr|[a-z0-9-]+-4x-fr|bestellen-[a-z0-9-]+|(?:basic|beauty|deluxe|exclusive)-(?:van|choc|mix)(?:-control)?|control1x|fruit-veg-berry-soft|fruit-veg-berry|fruit-veg-soft|fruit-vegtables|berries-omega|berries-soft|berries|essentials-omega|omegaselection|superfood))/i;

  if (currentReply) {
    const match = cleanText(currentReply).match(urlRegex);
    if (match) return match[1];
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "emma" && msg.message_text) {
      const match = cleanText(msg.message_text).match(urlRegex);
      if (match) return match[1];
    }
  }

  return "";
}

/* ------------------- SERVER-OWNED CHECKOUT DECISIONS -------------------- */

function normalizeCheckoutProgram(value) {
  const match = cleanText(value).match(/^(basic|beauty|deluxe|exclusive)$/i);
  if (!match) return "";
  const lower = match[1].toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function normalizeCheckoutTaste(value) {
  const normalized = cleanText(value).toLowerCase();
  if (["vanilla", "chocolate", "mix"].includes(normalized)) return normalized;
  return "";
}

function normalizeCheckoutControl(value) {
  const normalized = cleanText(value).toLowerCase();
  return ["yes", "no", "unavailable"].includes(normalized) ? normalized : "";
}

function resolveProgramCheckoutLink({
  customerCountry,
  program,
  taste,
  control,
  paymentMode,
}) {
  const normalizedProgram = normalizeCheckoutProgram(program);
  const normalizedTaste = normalizeCheckoutTaste(taste);
  const normalizedControl = normalizeCheckoutControl(control);
  if (!normalizedProgram || !normalizedTaste) return "";
  if (!['yes', 'no', 'unavailable'].includes(normalizedControl)) return "";
  if ((customerCountry || "").toUpperCase() === "PT" && normalizedControl === "yes") {
    return "";
  }

  const withControl = normalizedControl === "yes";
  const useFranceFourPayments =
    (customerCountry || "").toUpperCase() === "FR" &&
    paymentMode !== "one_time";

  if (useFranceFourPayments) {
    const programSlug = normalizedProgram.toLowerCase();
    const tasteSlug = normalizedTaste === "vanilla"
      ? "van"
      : normalizedTaste === "chocolate"
        ? "choc"
        : normalizedProgram === "Basic" && withControl
          ? "mix"
          : "mixte";
    return `https://tr.ee/${programSlug}-${tasteSlug}${withControl ? "-control" : ""}-4x-fr`;
  }

  const tasteSlug = normalizedTaste === "vanilla"
    ? "Van"
    : normalizedTaste === "chocolate"
      ? "Choc"
      : "Mix";
  return `https://tr.ee/${normalizedProgram}-${tasteSlug}${withControl ? "-Control" : ""}`;
}

function normalizeCheckoutUrl(value) {
  const match = cleanText(value).match(/https?:\/\/tr\.ee\/[^\s?#]+/i);
  return match ? match[0].replace(/\/$/, "").toLowerCase() : "";
}

// CHECKOUT PURE LOGIC START
function decideCheckoutAction({
  classification,
  recentMessages,
  customerCountry,
  validatedCustomer = false,
}) {
  const normal = {
    action: "normal",
    program: "",
    taste: "",
    control: "",
    payment_mode: "",
    checkout_link: "",
    previous_checkout_link: "",
  };

  if (
    !classification?.checkout_context_active ||
    classification?.checkout_confidence === "low"
  ) {
    return normal;
  }

  const messageType = cleanText(classification.checkout_message_type);
  const previousCheckoutLink = findLastEmmaCheckoutLink(recentMessages, "");
  const previousSku = parseCheckoutLinkSKU(previousCheckoutLink);

  if (messageType === "technical_cart_issue") {
    return { ...normal, action: "technical_retry", previous_checkout_link: previousCheckoutLink };
  }
  if (messageType === "technical_issue_persisting") {
    return { ...normal, action: "technical_escalate", previous_checkout_link: previousCheckoutLink };
  }
  if (messageType === "payment_status_uncertain") {
    return { ...normal, action: "payment_escalate", previous_checkout_link: previousCheckoutLink };
  }
  if (messageType === "link_resend_request" && previousCheckoutLink) {
    return {
      ...normal,
      action: "resend_link",
      checkout_link: previousCheckoutLink,
      previous_checkout_link: previousCheckoutLink,
    };
  }

  // A completed purchaser is handled by coaching/support rules. Never create a
  // replacement sales link automatically after order validation.
  if (validatedCustomer) return normal;

  if (!["selection_update", "selection_ambiguous"].includes(messageType)) {
  // Ambiguity, comparison and doubt belong to Emma's conversation. Repeating
  // a server-authored selection question is never a useful response to
  // uncertainty. The hard checkout controller only prepares facts after an
  // explicit, resolved selection update.
  if (
    messageType === "selection_ambiguous" ||
    messageType === "program_comparison"
  ) {
    return normal;
  }

  if (messageType !== "selection_update") return normal;

  const country = (customerCountry || "UNKNOWN").toUpperCase();
  const program =
    normalizeCheckoutProgram(classification.checkout_program) ||
    normalizeCheckoutProgram(previousSku?.program);
  const taste =
    normalizeCheckoutTaste(classification.checkout_taste) ||
    normalizeCheckoutTaste(previousSku?.taste);
  const classifiedControl = normalizeCheckoutControl(
    classification.checkout_control
  );

  if (country === "PT" && classifiedControl === "yes") {
    return {
      ...normal,
      action: "portugal_control_unavailable",
      program,
      taste,
      control: "unavailable",
      previous_checkout_link: previousCheckoutLink,
    };
  }

  const control = country === "PT"
    ? "unavailable"
    : classifiedControl ||
      (previousSku ? (previousSku.hasControl ? "yes" : "no") : "");
  const paymentMode = country === "FR"
    ? cleanText(classification.checkout_payment_mode) === "france_4x"
      ? "france_4x"
      : cleanText(classification.checkout_payment_mode) === "one_time"
        ? "one_time"
        : previousSku?.paymentMode === "one_time"
          ? "one_time"
          : "france_4x"
    : "one_time";

  const ambiguousField = cleanText(classification.checkout_ambiguous_field);
  if (messageType === "selection_ambiguous" && ambiguousField !== "none") {
    if (
      country === "PT" &&
      ["control", "taste_and_control"].includes(ambiguousField)
    ) {
      return {
        ...normal,
        action: taste ? "portugal_control_unavailable" : "ask_taste",
        program,
        taste,
        control: "unavailable",
        payment_mode: paymentMode,
        previous_checkout_link: previousCheckoutLink,
      };
    }
    const action = ambiguousField === "program"
      ? "ask_program"
      : ambiguousField === "taste"
        ? "ask_taste"
        : ambiguousField === "control"
          ? "ask_control"
          : "ask_taste_and_control";
    return {
      ...normal,
      action,
      program,
      taste,
      control,
      payment_mode: paymentMode,
      previous_checkout_link: previousCheckoutLink,
    };
  }

  if (!program) {
    return { ...normal, action: "ask_program", previous_checkout_link: previousCheckoutLink };
  }
  if (!taste && !control && country !== "PT") {
    return {
      ...normal,
      action: "ask_taste_and_control",
      program,
      payment_mode: paymentMode,
      previous_checkout_link: previousCheckoutLink,
    };
  }
  if (!taste) {
    return {
      ...normal,
      action: "ask_taste",
      program,
      control,
      payment_mode: paymentMode,
      previous_checkout_link: previousCheckoutLink,
    };
  }
  if (!control) {
    return {
      ...normal,
      action: "ask_control",
      program,
      taste,
      payment_mode: paymentMode,
      previous_checkout_link: previousCheckoutLink,
    };
  }

  const checkoutLink = resolveProgramCheckoutLink({
    customerCountry: country,
    program,
    taste,
    control,
    paymentMode,
  });
  if (!checkoutLink) return normal;

  const selection = {
    ...normal,
    program,
    taste,
    control,
    payment_mode: paymentMode,
    checkout_link: checkoutLink,
    previous_checkout_link: previousCheckoutLink,
  };
  if (!previousCheckoutLink) return { ...selection, action: "send_initial_link" };
  if (normalizeCheckoutUrl(previousCheckoutLink) === normalizeCheckoutUrl(checkoutLink)) {
    return { ...selection, action: "selection_unchanged" };
  }
  return { ...selection, action: "send_replacement_link" };
}
// CHECKOUT PURE LOGIC END

function shouldClassifyCheckoutState(message, recentMessages) {
  if (findLastEmmaCheckoutLink(recentMessages, "")) return true;
  if (hasAskedTaste(recentMessages) || hasReceivedTasteAnswer(recentMessages)) {
    return true;
  }
  const contextText = [
    ...recentMessages.slice(-20).map((msg) => cleanText(msg.message_text)),
    cleanText(message),
  ].join("\n");
  // This is only a broad scope gate for whether the semantic classifier needs
  // to run. It never decides a checkout state or customer intent itself.
  return /\b(basic|beauty|deluxe|exclusive|complete|control)\b/i.test(contextText);
}

const CHECKOUT_TASTE_LABELS = {
  nl: { vanilla: "Vanille", chocolate: "Chocolade", mix: "Half-half" },
  en: { vanilla: "Vanilla", chocolate: "Chocolate", mix: "Half-and-half" },
  fr: { vanilla: "Vanille", chocolate: "Chocolat", mix: "Moitié-moitié" },
  de: { vanilla: "Vanille", chocolate: "Schokolade", mix: "Halb-halb" },
  it: { vanilla: "Vaniglia", chocolate: "Cioccolato", mix: "Metà e metà" },
  es: { vanilla: "Vainilla", chocolate: "Chocolate", mix: "Mitad y mitad" },
  pt: { vanilla: "Baunilha", chocolate: "Chocolate", mix: "Meio a meio" },
  pl: { vanilla: "Wanilia", chocolate: "Czekolada", mix: "Pół na pół" },
};

function checkoutLanguage(language) {
  return CHECKOUT_TASTE_LABELS[language] ? language : "en";
}

function formatCheckoutSelection({ language, customerCountry, program, taste, control }) {
  const lang = checkoutLanguage(language);
  const tasteLabel = CHECKOUT_TASTE_LABELS[lang][taste] || taste;
  const base = `${program} ${tasteLabel}`;
  if ((customerCountry || "").toUpperCase() === "PT" || control === "unavailable") {
    return base;
  }
  const suffixes = {
    nl: control === "yes" ? "met Control" : "zonder Control",
    en: control === "yes" ? "with Control" : "without Control",
    fr: control === "yes" ? "avec Control" : "sans Control",
    de: control === "yes" ? "mit Control" : "ohne Control",
    it: control === "yes" ? "con Control" : "senza Control",
    es: control === "yes" ? "con Control" : "sin Control",
    pt: control === "yes" ? "com Control" : "sem Control",
    pl: control === "yes" ? "z Control" : "bez Control",
  };
  return `${base} ${suffixes[lang]}`;
}

const CHECKOUT_COPY = {
const CHECKOUT_LINK_FALLBACK_COPY = {
  nl: {
    askProgram: "Welk programma wil je bestellen: Basic, Beauty, Deluxe of Exclusive? 😊",
    askTaste: "Welke smaak Complete wil je: chocolade, vanille of half-half? 😊",
    askControl: "Wil je Control erbij doen? 😊",
    askBoth: "Welke smaak Complete wil je: chocolade, vanille of half-half? En wil je Control erbij doen? 😊",
    unchanged: (selection) => `Je huidige link klopt al voor ${selection} 💚`,
    replacement: (selection, link) => `Natuurlijk, ik pas het voor je aan 😊\n\nDit is de juiste link voor ${selection} 💚\n\n${link}\n\nStuur me je ordernummer zodra je hebt besteld, dan zet ik alles voor je klaar 😊`,
    resend: (link) => `Natuurlijk, hier is je checkoutlink nog een keer 💚\n\n${link}`,
    initial: (selection, link, payment) => `Top, ik stuur je de link voor ${selection} 💚\n\n${link}${payment ? `\n\n${payment}` : ""}\n\nZodra je hebt besteld, stuur me je ordernummer even door. Dan kan ik je alle gratis extra's geven en je direct toegang geven tot onze WhatsApp groep:\n✅ 24/7 persoonlijke coaching van mij\n✅ Toegang tot besloten WhatsApp groep\n✅ Toegang tot besloten Facebook groep\n✅ Complete toolkit\n✅ Recepten\n✅ Workouts`,
    paymentStandard: "Tijdens het uitchecken kan je in de laatste stap kiezen voor 3 termijnen via Klarna 😊",
    paymentFrance: "Tijdens het uitchecken betaal je in 4 maandtermijnen met creditcard 😊",
    technicalRetry: "Wat vervelend dat de checkout niet goed opent. Sluit je browser even helemaal af en klik daarna opnieuw op de link die ik je stuurde. Vaak opent het winkelwagentje dan wel goed 😊",
    technicalEscalate: "Wat vervelend dat het nog steeds niet werkt. Onze gesprekken worden gemonitord. Een van de mensen die dit account beheert, pakt je gesprek binnen 24 uur handmatig op en komt bij je terug met een oplossing 🙏",
    paymentEscalate: "Betaal voor de zekerheid niet opnieuw zolang niet duidelijk is of de betaling is verwerkt. Onze gesprekken worden gemonitord. Een van de mensen die dit account beheert, pakt je gesprek binnen 24 uur handmatig op en komt bij je terug met een oplossing 🙏",
    portugalControl: "Control is in Portugal helaas niet beschikbaar, dus ik kan dat niet aan je bestelling toevoegen. Je programma en smaak kan ik natuurlijk wel voor je klaarzetten 💚",
    askProgram: "Om de juiste checkoutlink te kunnen sturen, moet ik eerst weten welk programma je uiteindelijk kiest 😊",
    askTaste: "Welke smaak Complete wil je voor je checkout: chocolade, vanille of half-half? 😊",
    askControl: "Wil je Control bij je bestelling of liever zonder Control? 😊",
    askBoth: "Voor de juiste checkoutlink heb ik nog je smaak Complete en je keuze over Control nodig 😊",
    portugalControl: "Control is in Portugal niet beschikbaar. Ik kan wel de juiste link voor je programma en smaak klaarmaken 💚",
  },
  en: {
    askProgram: "Which programme would you like to order: Basic, Beauty, Deluxe or Exclusive? 😊",
    askTaste: "Which Complete flavour would you like: chocolate, vanilla or half-and-half? 😊",
    askControl: "Would you like to add Control? 😊",
    askBoth: "Which Complete flavour would you like: chocolate, vanilla or half-and-half? And would you like to add Control? 😊",
    unchanged: (selection) => `Your current link is already correct for ${selection} 💚`,
    replacement: (selection, link) => `Of course, I'll update that for you 😊\n\nHere is the correct link for ${selection} 💚\n\n${link}\n\nSend me your order number once you've ordered and I'll get everything ready for you 😊`,
    resend: (link) => `Of course, here is your checkout link again 💚\n\n${link}`,
    initial: (selection, link, payment) => `Great, here is the link for ${selection} 💚\n\n${link}${payment ? `\n\n${payment}` : ""}\n\nOnce you've ordered, send me your order number. Then I can give you all the free extras and immediate access to our WhatsApp group:\n✅ Personal coaching from me 24/7\n✅ Access to the private WhatsApp group\n✅ Access to the private Facebook group\n✅ Complete toolkit\n✅ Recipes\n✅ Workouts`,
    paymentStandard: "At checkout you can choose to pay in 3 instalments with Klarna in the final step 😊",
    paymentFrance: "At checkout you pay in 4 monthly instalments by credit card 😊",
    technicalRetry: "I'm sorry the checkout isn't opening properly. Close your browser completely, then click the link I sent you again. That usually makes the cart open correctly 😊",
    technicalEscalate: "I'm sorry it still isn't working. Our conversations are monitored. One of the people managing this account will pick up your conversation manually within 24 hours and come back to you with a solution 🙏",
    paymentEscalate: "To be safe, don't try to pay again while it's unclear whether the payment went through. Our conversations are monitored. One of the people managing this account will pick up your conversation manually within 24 hours and come back to you with a solution 🙏",
    portugalControl: "Unfortunately, Control isn't available in Portugal, so I can't add it to your order. I can still prepare your programme and flavour for you 💚",
    askProgram: "To provide the correct checkout link, I first need to know which programme you ultimately choose 😊",
    askTaste: "Which Complete flavour would you like for checkout: chocolate, vanilla or half-and-half? 😊",
    askControl: "Would you like Control with your order or would you prefer it without Control? 😊",
    askBoth: "For the correct checkout link, I still need your Complete flavour and your choice about Control 😊",
    portugalControl: "Control is not available in Portugal. I can still prepare the correct link for your programme and flavour 💚",
  },
  fr: {
    askProgram: "Quel programme souhaites-tu commander : Basic, Beauty, Deluxe ou Exclusive ? 😊",
    askTaste: "Quel parfum Complete souhaites-tu : chocolat, vanille ou moitié-moitié ? 😊",
    askControl: "Souhaites-tu ajouter Control ? 😊",
    askBoth: "Quel parfum Complete souhaites-tu : chocolat, vanille ou moitié-moitié ? Et souhaites-tu ajouter Control ? 😊",
    unchanged: (selection) => `Ton lien actuel correspond déjà à ${selection} 💚`,
    replacement: (selection, link) => `Bien sûr, je te modifie ça 😊\n\nVoici le bon lien pour ${selection} 💚\n\n${link}\n\nEnvoie-moi ton numéro de commande dès que tu as commandé et je préparerai tout pour toi 😊`,
    resend: (link) => `Bien sûr, voici à nouveau ton lien de commande 💚\n\n${link}`,
    initial: (selection, link, payment) => `Parfait, voici le lien pour ${selection} 💚\n\n${link}${payment ? `\n\n${payment}` : ""}\n\nDès que tu as commandé, envoie-moi ton numéro de commande. Je pourrai alors t'offrir tous les bonus et te donner immédiatement accès à notre groupe WhatsApp :\n✅ Mon coaching personnel 24 h/24 et 7 j/7\n✅ Accès au groupe WhatsApp privé\n✅ Accès au groupe Facebook privé\n✅ Boîte à outils complète\n✅ Recettes\n✅ Entraînements`,
    paymentStandard: "Lors du paiement, tu peux choisir Klarna en 3 fois à la dernière étape 😊",
    paymentFrance: "Lors du paiement, tu règles en 4 mensualités par carte bancaire 😊",
    technicalRetry: "Je suis désolée que le paiement ne s'ouvre pas correctement. Ferme complètement ton navigateur, puis clique à nouveau sur le lien que je t'ai envoyé. Le panier s'ouvre généralement correctement ensuite 😊",
    technicalEscalate: "Je suis désolée que cela ne fonctionne toujours pas. Nos conversations sont surveillées. Une personne qui gère ce compte reprendra manuellement ta conversation dans les 24 heures et reviendra vers toi avec une solution 🙏",
    paymentEscalate: "Par précaution, ne paie pas une deuxième fois tant qu'on ne sait pas si le paiement a été traité. Nos conversations sont surveillées. Une personne qui gère ce compte reprendra manuellement ta conversation dans les 24 heures et reviendra vers toi avec une solution 🙏",
    portugalControl: "Control n'est malheureusement pas disponible au Portugal, je ne peux donc pas l'ajouter à ta commande. Je peux bien sûr préparer ton programme et ton parfum 💚",
    askProgram: "Pour te donner le bon lien de commande, je dois d’abord savoir quel programme tu choisis finalement 😊",
    askTaste: "Quel parfum Complete souhaites-tu pour la commande : chocolat, vanille ou moitié-moitié ? 😊",
    askControl: "Souhaites-tu Control avec ta commande ou préfères-tu sans Control ? 😊",
    askBoth: "Pour préparer le bon lien de commande, il me faut encore ton parfum Complete et ton choix concernant Control 😊",
    portugalControl: "Control n’est pas disponible au Portugal. Je peux tout de même préparer le bon lien pour ton programme et ton parfum 💚",
  },
  de: {
    askProgram: "Welches Programm möchtest du bestellen: Basic, Beauty, Deluxe oder Exclusive? 😊",
    askTaste: "Welche Complete-Geschmacksrichtung möchtest du: Schokolade, Vanille oder halb-halb? 😊",
    askControl: "Möchtest du Control dazu nehmen? 😊",
    askBoth: "Welche Complete-Geschmacksrichtung möchtest du: Schokolade, Vanille oder halb-halb? Und möchtest du Control dazu nehmen? 😊",
    unchanged: (selection) => `Dein aktueller Link passt bereits zu ${selection} 💚`,
    replacement: (selection, link) => `Natürlich, ich ändere das für dich 😊\n\nHier ist der richtige Link für ${selection} 💚\n\n${link}\n\nSchick mir deine Bestellnummer, sobald du bestellt hast, dann bereite ich alles für dich vor 😊`,
    resend: (link) => `Natürlich, hier ist dein Checkout-Link noch einmal 💚\n\n${link}`,
    initial: (selection, link, payment) => `Super, hier ist der Link für ${selection} 💚\n\n${link}${payment ? `\n\n${payment}` : ""}\n\nSobald du bestellt hast, schick mir bitte deine Bestellnummer. Dann erhältst du alle kostenlosen Extras und sofort Zugang zu unserer WhatsApp-Gruppe:\n✅ Persönliches Coaching von mir rund um die Uhr\n✅ Zugang zur privaten WhatsApp-Gruppe\n✅ Zugang zur privaten Facebook-Gruppe\n✅ Komplettes Toolkit\n✅ Rezepte\n✅ Workouts`,
    paymentStandard: "Beim Bezahlen kannst du im letzten Schritt 3 Raten über Klarna wählen 😊",
    paymentFrance: "Beim Bezahlen zahlst du in 4 Monatsraten per Kreditkarte 😊",
    technicalRetry: "Es tut mir leid, dass sich der Checkout nicht richtig öffnet. Schließe deinen Browser vollständig und klicke danach noch einmal auf den Link, den ich dir geschickt habe. Meistens öffnet sich der Warenkorb dann richtig 😊",
    technicalEscalate: "Es tut mir leid, dass es immer noch nicht funktioniert. Unsere Gespräche werden überwacht. Eine Person, die dieses Konto betreut, übernimmt dein Gespräch innerhalb von 24 Stunden manuell und meldet sich mit einer Lösung bei dir 🙏",
    paymentEscalate: "Bezahle vorsichtshalber nicht noch einmal, solange unklar ist, ob die Zahlung verarbeitet wurde. Unsere Gespräche werden überwacht. Eine Person, die dieses Konto betreut, übernimmt dein Gespräch innerhalb von 24 Stunden manuell und meldet sich mit einer Lösung bei dir 🙏",
    portugalControl: "Control ist in Portugal leider nicht erhältlich, daher kann ich es deiner Bestellung nicht hinzufügen. Dein Programm und deine Geschmacksrichtung kann ich natürlich für dich vorbereiten 💚",
    askProgram: "Für den richtigen Checkout-Link muss ich zuerst wissen, für welches Programm du dich letztlich entscheidest 😊",
    askTaste: "Welche Complete-Geschmacksrichtung möchtest du für den Checkout: Schokolade, Vanille oder halb-halb? 😊",
    askControl: "Möchtest du Control zu deiner Bestellung oder lieber ohne Control? 😊",
    askBoth: "Für den richtigen Checkout-Link brauche ich noch deine Complete-Geschmacksrichtung und deine Entscheidung zu Control 😊",
    portugalControl: "Control ist in Portugal nicht erhältlich. Den richtigen Link für dein Programm und deine Geschmacksrichtung kann ich trotzdem vorbereiten 💚",
  },
  it: {
    askProgram: "Quale programma vuoi ordinare: Basic, Beauty, Deluxe o Exclusive? 😊",
    askTaste: "Quale gusto Complete preferisci: cioccolato, vaniglia o metà e metà? 😊",
    askControl: "Vuoi aggiungere Control? 😊",
    askBoth: "Quale gusto Complete preferisci: cioccolato, vaniglia o metà e metà? E vuoi aggiungere Control? 😊",
    unchanged: (selection) => `Il tuo link attuale è già corretto per ${selection} 💚`,
    replacement: (selection, link) => `Certo, lo modifico per te 😊\n\nEcco il link corretto per ${selection} 💚\n\n${link}\n\nQuando hai ordinato, mandami il numero d'ordine e preparo tutto per te 😊`,
    resend: (link) => `Certo, ecco di nuovo il tuo link per il checkout 💚\n\n${link}`,
    initial: (selection, link, payment) => `Perfetto, ecco il link per ${selection} 💚\n\n${link}${payment ? `\n\n${payment}` : ""}\n\nQuando hai ordinato, mandami il numero d'ordine. Così posso darti tutti gli extra gratuiti e l'accesso immediato al nostro gruppo WhatsApp:\n✅ Coaching personale con me 24/7\n✅ Accesso al gruppo WhatsApp privato\n✅ Accesso al gruppo Facebook privato\n✅ Toolkit completo\n✅ Ricette\n✅ Allenamenti`,
    paymentStandard: "Durante il checkout puoi scegliere Klarna in 3 rate nell'ultimo passaggio 😊",
    paymentFrance: "Durante il checkout paghi in 4 rate mensili con carta di credito 😊",
    technicalRetry: "Mi dispiace che il checkout non si apra correttamente. Chiudi completamente il browser e poi clicca di nuovo sul link che ti ho inviato. Di solito il carrello si apre correttamente 😊",
    technicalEscalate: "Mi dispiace che continui a non funzionare. Le nostre conversazioni vengono monitorate. Una delle persone che gestisce questo account prenderà in carico manualmente la conversazione entro 24 ore e ti contatterà con una soluzione 🙏",
    paymentEscalate: "Per sicurezza, non effettuare un altro pagamento finché non è chiaro se quello precedente è andato a buon fine. Le nostre conversazioni vengono monitorate. Una delle persone che gestisce questo account prenderà in carico manualmente la conversazione entro 24 ore e ti contatterà con una soluzione 🙏",
    portugalControl: "Purtroppo Control non è disponibile in Portogallo, quindi non posso aggiungerlo al tuo ordine. Posso comunque preparare il programma e il gusto per te 💚",
    askProgram: "Per inviarti il link corretto per il checkout, devo prima sapere quale programma scegli definitivamente 😊",
    askTaste: "Quale gusto Complete vuoi per il checkout: cioccolato, vaniglia o metà e metà? 😊",
    askControl: "Vuoi Control con il tuo ordine o lo preferisci senza Control? 😊",
    askBoth: "Per preparare il link corretto mi servono ancora il gusto Complete e la tua scelta su Control 😊",
    portugalControl: "Control non è disponibile in Portogallo. Posso comunque preparare il link corretto per il programma e il gusto 💚",
  },
  es: {
    askProgram: "¿Qué programa quieres pedir: Basic, Beauty, Deluxe o Exclusive? 😊",
    askTaste: "¿Qué sabor de Complete quieres: chocolate, vainilla o mitad y mitad? 😊",
    askControl: "¿Quieres añadir Control? 😊",
    askBoth: "¿Qué sabor de Complete quieres: chocolate, vainilla o mitad y mitad? ¿Y quieres añadir Control? 😊",
    unchanged: (selection) => `Tu enlace actual ya es correcto para ${selection} 💚`,
    replacement: (selection, link) => `Claro, te lo cambio 😊\n\nEste es el enlace correcto para ${selection} 💚\n\n${link}\n\nEnvíame tu número de pedido cuando hayas terminado y te lo preparo todo 😊`,
    resend: (link) => `Claro, aquí tienes de nuevo tu enlace de pago 💚\n\n${link}`,
    initial: (selection, link, payment) => `Perfecto, aquí tienes el enlace para ${selection} 💚\n\n${link}${payment ? `\n\n${payment}` : ""}\n\nCuando hayas hecho el pedido, envíame tu número de pedido. Así podré darte todos los extras gratuitos y acceso inmediato a nuestro grupo de WhatsApp:\n✅ Asesoramiento personal conmigo 24/7\n✅ Acceso al grupo privado de WhatsApp\n✅ Acceso al grupo privado de Facebook\n✅ Kit completo\n✅ Recetas\n✅ Entrenamientos`,
    paymentStandard: "Durante el pago puedes elegir Klarna en 3 plazos en el último paso 😊",
    paymentFrance: "Durante el pago abonas el importe en 4 mensualidades con tarjeta de crédito 😊",
    technicalRetry: "Siento que el proceso de pago no se abra correctamente. Cierra completamente el navegador y vuelve a pulsar el enlace que te envié. Normalmente así el carrito se abre bien 😊",
    technicalEscalate: "Siento que siga sin funcionar. Nuestras conversaciones están supervisadas. Una de las personas que gestiona esta cuenta revisará manualmente tu conversación en un plazo de 24 horas y volverá con una solución 🙏",
    paymentEscalate: "Para evitar problemas, no vuelvas a pagar mientras no esté claro si el pago se ha procesado. Nuestras conversaciones están supervisadas. Una de las personas que gestiona esta cuenta revisará manualmente tu conversación en un plazo de 24 horas y volverá con una solución 🙏",
    portugalControl: "Control no está disponible en Portugal, así que no puedo añadirlo a tu pedido. Sí puedo prepararte el programa y el sabor elegidos 💚",
    askProgram: "Para enviarte el enlace de pago correcto, primero necesito saber qué programa eliges finalmente 😊",
    askTaste: "¿Qué sabor de Complete quieres para el pago: chocolate, vainilla o mitad y mitad? 😊",
    askControl: "¿Quieres Control con tu pedido o lo prefieres sin Control? 😊",
    askBoth: "Para preparar el enlace correcto aún necesito tu sabor de Complete y tu elección sobre Control 😊",
    portugalControl: "Control no está disponible en Portugal. Sí puedo preparar el enlace correcto para tu programa y sabor 💚",
  },
  pt: {
    askProgram: "Que programa queres encomendar: Basic, Beauty, Deluxe ou Exclusive? 😊",
    askTaste: "Que sabor Complete queres: chocolate, baunilha ou meio a meio? 😊",
    askControl: "Queres adicionar Control? 😊",
    askBoth: "Que sabor Complete queres: chocolate, baunilha ou meio a meio? E queres adicionar Control? 😊",
    unchanged: (selection) => `O teu link atual já está correto para ${selection} 💚`,
    replacement: (selection, link) => `Claro, faço essa alteração para ti 😊\n\nEste é o link correto para ${selection} 💚\n\n${link}\n\nEnvia-me o número da encomenda assim que terminares e eu preparo tudo para ti 😊`,
    resend: (link) => `Claro, aqui tens novamente o teu link de checkout 💚\n\n${link}`,
    initial: (selection, link, payment) => `Perfeito, aqui tens o link para ${selection} 💚\n\n${link}${payment ? `\n\n${payment}` : ""}\n\nAssim que fizeres a encomenda, envia-me o número. Depois posso dar-te todos os extras gratuitos e acesso imediato ao nosso grupo de WhatsApp:\n✅ Acompanhamento pessoal comigo 24 horas por dia\n✅ Acesso ao grupo privado de WhatsApp\n✅ Acesso ao grupo privado de Facebook\n✅ Kit completo\n✅ Receitas\n✅ Treinos`,
    paymentStandard: "No último passo do checkout podes escolher o pagamento em 3 prestações através da Klarna 😊",
    paymentFrance: "No checkout, o pagamento é feito em 4 prestações mensais com cartão de crédito 😊",
    technicalRetry: "Lamento que o checkout não esteja a abrir corretamente. Fecha completamente o navegador e depois volta a clicar no link que te enviei. Normalmente o carrinho abre corretamente dessa forma 😊",
    technicalEscalate: "Lamento que continue sem funcionar. As nossas conversas são monitorizadas. Uma das pessoas que gere esta conta irá analisar manualmente a tua conversa no prazo de 24 horas e voltará com uma solução 🙏",
    paymentEscalate: "Por segurança, não voltes a pagar enquanto não estiver claro se o pagamento foi processado. As nossas conversas são monitorizadas. Uma das pessoas que gere esta conta irá analisar manualmente a tua conversa no prazo de 24 horas e voltará com uma solução 🙏",
    portugalControl: "Infelizmente, o Control não está disponível em Portugal, por isso não o posso adicionar à tua encomenda. Posso preparar o programa e o sabor para ti 💚",
    askProgram: "Para te enviar o link de checkout correto, preciso primeiro de saber qual programa escolhes no final 😊",
    askTaste: "Que sabor Complete queres para o checkout: chocolate, baunilha ou meio a meio? 😊",
    askControl: "Queres Control na encomenda ou preferes sem Control? 😊",
    askBoth: "Para preparar o link correto, ainda preciso do sabor Complete e da tua escolha sobre Control 😊",
    portugalControl: "Control não está disponível em Portugal. Posso preparar o link correto para o teu programa e sabor 💚",
  },
  pl: {
    askProgram: "Który program chcesz zamówić: Basic, Beauty, Deluxe czy Exclusive? 😊",
    askTaste: "Który smak Complete wybierasz: czekoladowy, waniliowy czy pół na pół? 😊",
    askControl: "Czy chcesz dodać Control? 😊",
    askBoth: "Który smak Complete wybierasz: czekoladowy, waniliowy czy pół na pół? Czy chcesz też dodać Control? 😊",
    unchanged: (selection) => `Twój obecny link jest już właściwy dla ${selection} 💚`,
    replacement: (selection, link) => `Oczywiście, zmienię to dla Ciebie 😊\n\nOto właściwy link dla ${selection} 💚\n\n${link}\n\nPo złożeniu zamówienia wyślij mi numer zamówienia, a wszystko dla Ciebie przygotuję 😊`,
    resend: (link) => `Oczywiście, tutaj ponownie znajdziesz swój link do zamówienia 💚\n\n${link}`,
    initial: (selection, link, payment) => `Świetnie, oto link dla ${selection} 💚\n\n${link}${payment ? `\n\n${payment}` : ""}\n\nPo złożeniu zamówienia wyślij mi numer zamówienia. Otrzymasz wtedy wszystkie bezpłatne dodatki i natychmiastowy dostęp do naszej grupy WhatsApp:\n✅ Moje osobiste wsparcie 24/7\n✅ Dostęp do prywatnej grupy WhatsApp\n✅ Dostęp do prywatnej grupy na Facebooku\n✅ Kompletny zestaw materiałów\n✅ Przepisy\n✅ Treningi`,
    paymentStandard: "W ostatnim kroku płatności możesz wybrać 3 raty przez Klarna 😊",
    paymentFrance: "Podczas płatności zapłacisz w 4 miesięcznych ratach kartą kredytową 😊",
    technicalRetry: "Przykro mi, że strona płatności nie otwiera się prawidłowo. Zamknij całkowicie przeglądarkę, a następnie ponownie kliknij wysłany przeze mnie link. Zwykle koszyk otwiera się wtedy poprawnie 😊",
    technicalEscalate: "Przykro mi, że nadal nie działa. Nasze rozmowy są monitorowane. Jedna z osób zarządzających tym kontem przejmie ręcznie Twoją rozmowę w ciągu 24 godzin i wróci z rozwiązaniem 🙏",
    paymentEscalate: "Dla bezpieczeństwa nie płać ponownie, dopóki nie będzie jasne, czy płatność została przetworzona. Nasze rozmowy są monitorowane. Jedna z osób zarządzających tym kontem przejmie ręcznie Twoją rozmowę w ciągu 24 godzin i wróci z rozwiązaniem 🙏",
    portugalControl: "Control nie jest dostępny w Portugalii, więc nie mogę dodać go do zamówienia. Mogę natomiast przygotować wybrany program i smak 💚",
    askProgram: "Aby wysłać właściwy link do zamówienia, muszę najpierw wiedzieć, który program ostatecznie wybierasz 😊",
    askTaste: "Który smak Complete wybierasz do zamówienia: czekoladowy, waniliowy czy pół na pół? 😊",
    askControl: "Czy chcesz Control do zamówienia, czy wolisz bez Control? 😊",
    askBoth: "Do przygotowania właściwego linku potrzebuję jeszcze smaku Complete i decyzji dotyczącej Control 😊",
    portugalControl: "Control nie jest dostępny w Portugalii. Mogę jednak przygotować właściwy link dla wybranego programu i smaku 💚",
  },
};

function buildCheckoutActionReply({ decision, language, customerCountry }) {
  const lang = checkoutLanguage(language);
  const copy = CHECKOUT_COPY[lang];
  if (decision.action === "ask_program") return copy.askProgram;
  if (decision.action === "ask_taste") return copy.askTaste;
  if (decision.action === "ask_control") return copy.askControl;
  if (decision.action === "ask_taste_and_control") return copy.askBoth;
  if (decision.action === "technical_retry") return copy.technicalRetry;
  if (decision.action === "technical_escalate") return copy.technicalEscalate;
  if (decision.action === "payment_escalate") return copy.paymentEscalate;
  if (decision.action === "portugal_control_unavailable") return copy.portugalControl;
  if (decision.action === "resend_link") return copy.resend(decision.checkout_link);
function buildCheckoutTurnGuard({
  decision,
  classification,
  language,
  customerCountry,
}) {
  const action = cleanText(decision?.action);
  const messageType = cleanText(classification?.checkout_message_type);

  const selection = formatCheckoutSelection({
    language: lang,
    customerCountry,
    program: decision.program,
    taste: decision.taste,
    control: decision.control,
  });
  if (decision.action === "selection_unchanged") return copy.unchanged(selection);
  if (decision.action === "send_replacement_link") {
    return copy.replacement(selection, decision.checkout_link);
  if (messageType === "program_comparison") {
    return [
      "CONVERSATIONELE KEUZEHULP: de klant vergelijkt programma's of twijfelt nog en heeft nog geen definitieve bestelkeuze gemaakt.",
      "Geef zelf natuurlijk en persoonlijk advies vanuit het volledige gesprek. Start geen checkout, som niet automatisch alle programma's op en vraag niet welk programma de klant wil bestellen.",
    ].join("\n");
  }
  if (decision.action === "send_initial_link") {
    const payment = (customerCountry || "").toUpperCase() === "FR"
      ? decision.payment_mode === "france_4x"
        ? copy.paymentFrance
        : ""
      : copy.paymentStandard;
    return copy.initial(selection, decision.checkout_link, payment);

  if (!action || action === "normal") return "";

  const selection =
    decision?.program && decision?.taste && decision?.control
    ? formatCheckoutSelection({
        language,
        customerCountry,
        program: decision.program,
        taste: decision.taste,
        control: decision.control,
      })
    : "";
  const intro =
    "TECHNISCHE CHECKOUTCONTEXT: onderstaande feiten zijn door de server gecontroleerd. Schrijf het klantantwoord altijd zelf natuurlijk en passend bij het volledige gesprek; kopieer geen serverzin.";

  if (action === "ask_program") {
    return [
      intro,
      "De klant heeft aantoonbaar een checkoutkeuze bijgewerkt, maar er is nog geen definitief programma bekend. Vraag alleen op een natuurlijke manier naar het ontbrekende programma en stuur nog geen checkoutlink.",
    ].join("\n");
  }
  if (action === "ask_taste") {
    return [
      intro,
      `Het programma is ${decision.program || "bekend"}, maar de Complete-smaak ontbreekt nog. Vraag alleen natuurlijk naar chocolade, vanille of half-half en stuur nog geen checkoutlink.`,
    ].join("\n");
  }
  if (action === "ask_control") {
    return [
      intro,
      `Programma en smaak zijn bekend${selection ? ` (${selection})` : ""}, maar de klant heeft nog niet gekozen of Control erbij moet. Vraag alleen natuurlijk naar Control ja of nee en stuur nog geen checkoutlink.`,
    ].join("\n");
  }
  if (action === "ask_taste_and_control") {
    return [
      intro,
      `Het programma is ${decision.program || "bekend"}, maar smaak en Control ja/nee ontbreken nog. Vraag deze twee keuzes natuurlijk en compact; stuur nog geen checkoutlink.`,
    ].join("\n");
  }
  if (action === "send_initial_link") {
    return [
      intro,
      `De definitieve combinatie is ${selection}. Gebruik exact deze checkoutlink: ${decision.checkout_link}`,
      "Dit is de eerste checkoutlink. Schrijf het organische eerste checkoutbericht volgens Stap 5.3, inclusief het eenmalige freebiesblok en de vraag om het ordernummer.",
    ].join("\n");
  }
  if (action === "send_replacement_link") {
    return [
      intro,
      `De klant heeft een eerdere keuze gewijzigd. De nieuwe definitieve combinatie is ${selection}. Gebruik exact deze vervangende checkoutlink: ${decision.checkout_link}`,
      "Bevestig de wijziging natuurlijk. Herhaal het freebiesblok en de betaaluitleg niet; vraag alleen weer om het ordernummer.",
    ].join("\n");
  }
  if (action === "selection_unchanged") {
    return [
      intro,
      `De bestaande checkoutlink hoort al bij de huidige combinatie ${selection}. Stuur geen nieuwe link tenzij de klant daar expliciet om vraagt; reageer verder natuurlijk op haar bedoeling.`,
    ].join("\n");
  }
  if (action === "resend_link") {
    return [
      intro,
      `De klant vraagt de bestaande checkoutlink opnieuw. Gebruik exact deze link: ${decision.checkout_link}`,
      "Stuur alleen een korte natuurlijke begeleidende zin met de link; herhaal geen freebiesblok.",
    ].join("\n");
  }
  if (action === "technical_retry") {
    return [
      intro,
      "De checkout of het winkelwagentje opent voor het eerst niet goed. Leg natuurlijk uit dat de klant de browser volledig moet sluiten en daarna opnieuw op dezelfde link moet klikken.",
    ].join("\n");
  }
  if (action === "technical_escalate") {
    return [
      intro,
      "De browserinstructie is al geprobeerd en het probleem blijft bestaan. Meld natuurlijk dat gesprekken worden gemonitord en dat iemand die het account beheert het gesprek binnen 24 uur handmatig overneemt met een oplossing.",
    ].join("\n");
  }
  if (action === "payment_escalate") {
    return [
      intro,
      "Het is onzeker of een betaling al is uitgevoerd. Zeg dat de klant niet opnieuw moet betalen, dat gesprekken worden gemonitord en dat iemand die het account beheert het gesprek binnen 24 uur handmatig overneemt met een oplossing.",
    ].join("\n");
  }
  if (action === "portugal_control_unavailable") {
    return [
      intro,
      "Control is technisch niet leverbaar in Portugal. Leg dat natuurlijk uit en help verder met het programma en de smaak, zonder een Control-link te sturen.",
    ].join("\n");
  }

  return "";
}

const PROGRAM_CHECKOUT_URL_PATTERN =
  /https?:\/\/tr\.ee\/(?:basic|beauty|deluxe|exclusive)-(?:van|choc|mixte|mix)(?:-control)?(?:-4x-fr)?\b/gi;
const CONTROL_ONLY_CHECKOUT_URL_PATTERN =
  /https?:\/\/tr\.ee\/(?:control1x|control-4x-fr)\b/gi;

function hasExplicitOneTimePaymentRequest(text) {
  return /\b(in (?:één|een) keer|alles (?:in )?(?:één|een) keer|eenmalig|one[-\s]?time|in one (?:go|payment)|pay in full|single payment|en une seule fois|paiement unique|einmalig|auf einmal|in un['’]unica soluzione|pagamento unico|en un solo pago|pago [uú]nico|de uma s[oó] vez|pagamento [uú]nico|jednorazowo|jedna płatno[sś][cć])\b/i.test(
    cleanText(text)
  );
}

const MARKET_AVAILABILITY_COPY = {
  nl: (product) => `${product} is helaas niet beschikbaar in België, dus daarvoor kan ik geen checkoutlink sturen.`,
  en: (product) => `Unfortunately, ${product} isn't available in Belgium, so I can't send a checkout link for it.`,
  fr: (product) => `Malheureusement, ${product} n’est pas disponible en Belgique, je ne peux donc pas envoyer de lien de commande pour ce produit.`,
  de: (product) => `${product} ist in Belgien leider nicht erhältlich, deshalb kann ich dafür keinen Checkout-Link senden.`,
  it: (product) => `Purtroppo ${product} non è disponibile in Belgio, quindi non posso inviare un link per l’ordine.`,
  es: (product) => `${product} no está disponible en Bélgica, así que no puedo enviar un enlace de compra para este producto.`,
  pt: (product) => `Infelizmente, ${product} não está disponível na Bélgica, por isso não posso enviar um link de checkout para este produto.`,
  pl: (product) => `${product} nie jest dostępny w Belgii, dlatego nie mogę wysłać linku do zamówienia tego produktu.`,
};

// Final deterministic backstop for links generated inside a normal AI reply.
// The earlier checkout decision path already handles most ordering turns; this
// catches any link that still reaches the final reply and verifies all required
// choices plus the country-specific link family before it is returned.
function enforceCheckoutLinksInReply({
  reply,
  classification,
  recentMessages,
  customerCountry,
  language,
  currentMessage = "",
}) {
  const text = cleanReplyText(reply);
  const country = (customerCountry || "UNKNOWN").toUpperCase();
  const lang = checkoutLanguage(language);
  const copy = CHECKOUT_COPY[lang];
  const copy = CHECKOUT_LINK_FALLBACK_COPY[lang];

  const belgiumUnavailableLink = country === "BE"
    ? text.match(
        /https?:\/\/tr\.ee\/(superfood|bestellen-nl-superfoods|bestellen-nl-luminate(?:15|30)|bestellen-nl-soep30)(?:\b|\/|\?|$)/i
      )
    : null;
  if (belgiumUnavailableLink) {
    const slug = belgiumUnavailableLink[1].toLowerCase();
    const product = slug.includes("luminate")
      ? "Luminate"
      : slug.includes("soep30")
        ? "Complete Vegetable Soup 30p"
        : "Superfood";
    const unavailableCopy =
      MARKET_AVAILABILITY_COPY[lang] || MARKET_AVAILABILITY_COPY.en;
    return {
      reply: unavailableCopy(product),
      changed: true,
      reason: "belgium_product_unavailable",
    };
  }

  const controlOnlyLinks = text.match(CONTROL_ONLY_CHECKOUT_URL_PATTERN) || [];
  if (controlOnlyLinks.length > 0) {
    if (country === "PT") {
      return {
        reply: copy.portugalControl,
        changed: true,
        reason: "portugal_control_unavailable",
      };
    }
    const requestedPaymentMode = cleanText(classification?.checkout_payment_mode);
    const oneTimeExplicit =
      requestedPaymentMode === "one_time" ||
      hasExplicitOneTimePaymentRequest(currentMessage);
    const expectedControlLink = country === "FR" && !oneTimeExplicit
      ? "https://tr.ee/control-4x-fr"
      : "https://tr.ee/Control1x";
    const replacedControl = text.replace(
      CONTROL_ONLY_CHECKOUT_URL_PATTERN,
      expectedControlLink
    );
    if (replacedControl !== text) {
      return {
        reply: replacedControl,
        changed: true,
        reason: "control_link_country_corrected",
      };
    }
  }

  const programmeLinks = text.match(PROGRAM_CHECKOUT_URL_PATTERN) || [];
  if (programmeLinks.length === 0) {
    return { reply: text, changed: false, reason: "no_programme_link" };
  }
  const withoutProgrammeLinks = cleanReplyText(
    text.replace(PROGRAM_CHECKOUT_URL_PATTERN, "")
  );
  const blockUnresolvedLink = (fallback, reason) => ({
    // Preserve Emma's contextual explanation whenever possible. A short
    // server-authored question is used only if her entire reply consisted of
    // an unsafe checkout link and would otherwise become empty.
    reply: withoutProgrammeLinks || fallback,
    changed: true,
    reason,
  });

  const previousCheckoutLink = findLastEmmaCheckoutLink(recentMessages, "");
  const previousSku = parseCheckoutLinkSKU(previousCheckoutLink);
  const programme =
    normalizeCheckoutProgram(classification?.checkout_program) ||
    normalizeCheckoutProgram(previousSku?.program);
  const taste =
    normalizeCheckoutTaste(classification?.checkout_taste) ||
    normalizeCheckoutTaste(previousSku?.taste);
  const classifiedControl = normalizeCheckoutControl(
    classification?.checkout_control
  );

  if (country === "PT" && classifiedControl === "yes") {
    return {
      reply: copy.portugalControl,
      changed: true,
      reason: "portugal_control_unavailable",
    };
  }

  const control = country === "PT"
    ? "unavailable"
    : classifiedControl ||
      (previousSku ? (previousSku.hasControl ? "yes" : "no") : "");
  const ambiguousField = cleanText(classification?.checkout_ambiguous_field);

  if (!programme || ambiguousField === "program") {
    return { reply: copy.askProgram, changed: true, reason: "program_missing" };
    return blockUnresolvedLink(
      copy.askProgram,
      "programme_link_removed_program_unresolved"
    );
  }
  if (
    ambiguousField === "taste_and_control" ||
    (!taste && !control && country !== "PT")
  ) {
    return {
      reply: copy.askBoth,
      changed: true,
      reason: "taste_and_control_missing",
    };
    return blockUnresolvedLink(
      copy.askBoth,
      "programme_link_removed_taste_and_control_unresolved"
    );
  }
  if (!taste || ambiguousField === "taste") {
    return { reply: copy.askTaste, changed: true, reason: "taste_missing" };
    return blockUnresolvedLink(
      copy.askTaste,
      "programme_link_removed_taste_unresolved"
    );
  }
  if ((!control || ambiguousField === "control") && country !== "PT") {
    return { reply: copy.askControl, changed: true, reason: "control_missing" };
    return blockUnresolvedLink(
      copy.askControl,
      "programme_link_removed_control_unresolved"
    );
  }

  const paymentMode = country === "FR"
    ? cleanText(classification?.checkout_payment_mode) === "one_time" ||
        hasExplicitOneTimePaymentRequest(currentMessage)
      ? "one_time"
      : previousSku?.paymentMode === "one_time" &&
          cleanText(classification?.checkout_payment_mode) !== "france_4x"
        ? "one_time"
        : "france_4x"
    : "one_time";
  const expectedLink = resolveProgramCheckoutLink({
    customerCountry: country,
    program: programme,
    taste,
    control,
    paymentMode,
  });

  if (!expectedLink) {
    return {
      reply: country === "PT" ? copy.portugalControl : copy.askBoth,
      changed: true,
      reason: "expected_link_unresolved",
    };
    return blockUnresolvedLink(
      country === "PT" ? copy.portugalControl : copy.askBoth,
      "programme_link_removed_expected_link_unresolved"
    );
  }

  const corrected = text.replace(PROGRAM_CHECKOUT_URL_PATTERN, expectedLink);
  return {
    reply: corrected,
    changed: corrected !== text,
    reason: corrected !== text ? "programme_link_corrected" : "programme_link_valid",
  };
}

function userMessagesContainOrderNumber(messages, currentUserMessage) {
  if (currentUserMessage && ORDER_NUMBER_PATTERN.test(cleanText(currentUserMessage))) {
    return true;
  }

  return messages.some(
    (msg) =>
      msg.role === "user" &&
      ORDER_NUMBER_PATTERN.test(cleanText(msg.message_text))
  );
}

function findProgramInText(text) {
  if (!text) return "";
  const matches = text.match(PROGRAM_PATTERN_GLOBAL);
  if (!matches || matches.length === 0) return "";
  const lastMatch = matches[matches.length - 1];
  const lower = lastMatch.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function findEmmaConfirmationMessage(messages, currentReply) {
  // The "confirmation" is the most recent Emma message that contains the
  // WhatsApp group link. Prefer the current reply if it contains the link.
  if (currentReply && /chat\.whatsapp\.com/i.test(cleanText(currentReply))) {
    return cleanText(currentReply);
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg.role === "emma" &&
      /chat\.whatsapp\.com/i.test(cleanText(msg.message_text))
    ) {
      return cleanText(msg.message_text);
    }
  }

  return "";
}

function extractPurchasedProgram(messages, currentReply) {
  // Primary source: the last checkout URL Emma sent. The URL is the canonical
  // truth about what the customer was directed to purchase, and is reliable
  // regardless of what Emma writes in her post-order confirmation message.
  const lastUrl = findLastEmmaCheckoutLink(messages, currentReply);
  const fromUrl = parseCheckoutLinkSKU(lastUrl);
  if (fromUrl) {
    return fromUrl.program;
  }

  // Fallback: parse Emma's post-order confirmation message (the one with the
  // WhatsApp group link). Used when no checkout URL was sent earlier in the
  // conversation, e.g. the customer arrived with an order number they got
  // through a different channel.
  const confirmationText = findEmmaConfirmationMessage(messages, currentReply);
  return findProgramInText(confirmationText);
}

function extractInterestedInProgram(messages, currentUserMessage) {
  // Program interest is based only on the customer's own statements or
  // choices. A program suggested by Emma must never be stored as customer
  // interest. Take the customer's LAST explicit program mention.
  let lastMatch = "";

  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const found = findProgramInText(cleanText(msg.message_text));
    if (found) lastMatch = found;
  }

  const userFound = findProgramInText(cleanText(currentUserMessage));
  if (userFound) lastMatch = userFound;

  return lastMatch;
}

function deriveHasControl(messages, currentReply, programName) {
  // Returns "ja" / "nee" for consistency with the interested_in_control field
  // (both fields use the same Dutch boolean style in Airtable, instead of the
  // English "true"/"false" which created select-option mismatches).
  //
  // Primary source: the last checkout URL Emma sent. If the URL ends with
  // "-control" the customer was directed to a combo SKU; if it's a plain
  // control URL (tr.ee/bestellen-{land}-control) the customer bought
  // standalone Control. The URL is the canonical truth.
  const lastUrl = findLastEmmaCheckoutLink(messages, currentReply);
  const fromUrl = parseCheckoutLinkSKU(lastUrl);
  if (fromUrl) {
    return fromUrl.hasControl ? "ja" : "nee";
  }

  // Fallback (no checkout URL was sent): use the legacy text-based detection
  // on Emma's confirmation message.
  if (!programName) return "ja";

  const confirmationText = findEmmaConfirmationMessage(messages, currentReply);
  if (!confirmationText) return "nee";

  return CONTROL_COMBO_PATTERN.test(confirmationText) ? "ja" : "nee";
}

function deriveInterestedInControl(messages, currentUserMessage) {
  // Store Control interest only when the customer shows demonstrably positive
  // interest. Emma mentioning or explaining Control is never sufficient.
  // Negative answers are deliberately returned as an empty update so they can
  // never be stored as positive interest.
  const positiveWithControl =
    /(?:\b(?:ja|jazeker|graag|prima|zeker|doe\s*maa?r[ts]?|inderdaad|natuurlijk|oke|ok|yes|yeah|sure|please|oui|d['’]accord|bien s[uû]r|si|s[iíì]|certo|claro|sim|tak|dobrze|oczywi[sś]cie)\b.{0,50}\bcontrol\b|\bcontrol\b.{0,50}\b(?:ja|jazeker|graag|prima|zeker|doe\s*maa?r[ts]?|inderdaad|natuurlijk|oke|ok|yes|yeah|sure|please|oui|d['’]accord|bien s[uû]r|si|s[iíì]|certo|claro|sim|tak|dobrze|oczywi[sś]cie|erbij|toevoegen|nemen|wil|bestellen|add|ajouter|hinzuf[uü]gen|aggiungere|a[nñ]adir|adicionar|doda[cć])\b)/i;
  const negativeWithControl =
    /(?:\b(?:nee|geen|zonder|liever\s+niet|laat\s+maar|no|nope|without|non|sans|nein|ohne|senza|sin|n[aã]o|sem|nie|bez)\b.{0,50}\bcontrol\b|\bcontrol\b.{0,50}\b(?:nee|niet|geen|zonder|liever\s+niet|laat\s+maar|no|nope|without|non|sans|nein|ohne|senza|sin|n[aã]o|sem|nie|bez)\b)/i;
  const standalonePositive =
    /^\s*(?:ja|jazeker|graag|prima|doe\s*maa?r[ts]?|inderdaad|natuurlijk|zeker|ok[eé]?|jep|yes|yeah|sure|please|oui|d['’]accord|bien s[uû]r|si|s[iíì]|certo|claro|sim|tak|dobrze|oczywi[sś]cie)(?:\s+(?:graag|please|zeker|prima|doe\s*maa?r[ts]?|natuurlijk|sure|por favor))?\s*[.!]?\s*$/i;
  const standaloneNegative =
    /^\s*(?:nee|nope|geen|niks|no|non|nein|n[aã]o|nie)(?:,?\s*(?:dank\s*je(?:\s*wel)?|bedankt|thanks?|thank you|merci|danke|grazie|gracias|obrigad[oa]|dzi[eę]kuj[eę]|laat\s+maar|hoor|joh|por favor))?\s*[.!]?\s*$/i;

  let lastEmmaControlAsk = -1;
  const emmaControlQuestionPattern =
    /(?:wil je|zou je|would you|do you want|souhaites-tu|veux-tu|m[oö]chtest du|willst du|vuoi|quieres|queres|czy chcesz).{0,80}\bcontrol\b|\bcontrol\b.{0,80}(?:erbij|toevoegen|add|ajouter|hinzuf[uü]gen|dazu|aggiungere|a[nñ]adir|adicionar|doda[cć]|\?)/i;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "emma" && emmaControlQuestionPattern.test(cleanText(msg.message_text))) {
      lastEmmaControlAsk = i;
      break;
    }
  }

  const customerTexts = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") {
      customerTexts.push({ index: i, text: cleanText(messages[i].message_text) });
    }
  }
  if (currentUserMessage) {
    customerTexts.push({ index: messages.length, text: cleanText(currentUserMessage) });
  }

  for (let i = customerTexts.length - 1; i >= 0; i--) {
    const { index, text } = customerTexts[i];
    if (!text) continue;

    if (negativeWithControl.test(text)) return "";
    if (positiveWithControl.test(text)) return "ja";

    // A simple "ja" counts when it answers the latest still-open Control
    // question. Intervening Emma explanations do not close that question.
    if (lastEmmaControlAsk >= 0 && index > lastEmmaControlAsk) {
      if (standaloneNegative.test(text)) return "";
      if (standalonePositive.test(text)) return "ja";
    }
  }

  return "";
}

function derivePurchaseFields({
  recentMessages,
  currentUserMessage,
  currentReply,
  whatsappGroupLinkSentNowOrEarlier,
}) {
  // Hard gate: a valid JP04 order number from the user AND a checkout link
  // sent by Emma. The checkout URL is the canonical purchased SKU.
  const orderNumberPresent = userMessagesContainOrderNumber(
    recentMessages,
    currentUserMessage
  );

  const checkoutLink = findLastEmmaCheckoutLink(recentMessages, currentReply);
  const validated = orderNumberPresent && Boolean(checkoutLink);

  // interested_in_program / interested_in_control can be derived independently
  // of the purchase trigger (a customer can be "interested" before buying).
  const interestedInProgram = extractInterestedInProgram(
    recentMessages,
    currentUserMessage
  );
  const interestedInControlSignal = deriveInterestedInControl(
    recentMessages,
    currentUserMessage
  );

  if (!validated) {
    return {
      validated: false,
      purchased_program: "",
      has_control: "",
      interested_in_program: interestedInProgram,
      interested_in_control: interestedInControlSignal,
    };
  }

  // Validated purchase -> derive purchased_program from Emma's confirmation
  // message only (the message that contains the WhatsApp group link).
  const purchasedProgram = extractPurchasedProgram(recentMessages, currentReply);
  const hasControl = deriveHasControl(
    recentMessages,
    currentReply,
    purchasedProgram
  );

  return {
    validated: true,
    purchased_program: purchasedProgram,
    has_control: hasControl,
    interested_in_program: interestedInProgram,
    interested_in_control: interestedInControlSignal,
  };
}

function detectState({
  currentMessage,
  recentMessages,
  lastSummary,
  currentPhase,
  customerStatus = "",
}) {
  const hasPreviousEmmaMessage = recentMessages.some(
    (msg) => msg.role === "emma"
  );

  const isExistingConversation =
    hasPreviousEmmaMessage || Boolean(cleanText(lastSummary));

  const latest = cleanText(currentMessage).toLowerCase();

  const hasMedicalTrigger =
    /\b(zwanger|zwangerschap|borstvoeding|actieve?\s+chemo|chemo(?:therapie)?|eetstoornis|anorexia|boulimia|binge[-\s]?eating)\b/i.test(
      latest
    );

  const hasPurchaseClaim =
    /\b(besteld|order|ordernummer|betaald|gekocht|whatsapp.?groep|groep|toegang|ordered|order number|paid|bought|whatsapp group|access|command[eé]|num[eé]ro de commande|pay[eé]|achet[eé]|groupe whatsapp|acc[eè]s|bestellt|bestellnummer|bezahlt|gekauft|whatsapp-gruppe|zugang|ordinato|numero d['’]ordine|pagato|acquistato|gruppo whatsapp|accesso|pedido|n[uú]mero (?:del pedido|da encomenda|do pedido)|pagado|pago|comprado|grupo (?:de )?whatsapp|acceso|acesso|zam[oó]wion|numer zam[oó]wienia|zapłacon|kupion|grupa whatsapp|dost[eę]p)\b/i.test(
      latest
    );
  const hasExplicitBuyingIntent =
    /\b(bestellen|starten|ik wil starten|hoe bestel|link|kopen|aanschaffen|doorgaan|order|start|how (?:do|can) i order|buy|purchase|send (?:me )?the link|commander|commencer|acheter|envoie(?:-moi)? le lien|bestellen|anfangen|kaufen|schick mir den link|ordinare|iniziare|comprare|invia il link|pedir|empezar|comprar|env[ií]a(?:me)? el enlace|encomendar|come[cç]ar|comprar|envia(?:-me)? o link|zam[oó]wi[cć]|zaczą[cć]|kupi[cć]|wy[sś]lij link)\b/i.test(
      latest
    );

  const isValidatedCustomer = isCustomerStatusValidated(
    customerStatus,
    recentMessages
  );

  return {
    is_existing_conversation: isExistingConversation,
    has_previous_emma_message: hasPreviousEmmaMessage,
    has_medical_trigger: hasMedicalTrigger,
    has_purchase_claim: hasPurchaseClaim,
    has_explicit_buying_intent: hasExplicitBuyingIntent,
    is_validated_customer: isValidatedCustomer,
    should_use_coaching_mode: isValidatedCustomer,
    current_phase: isValidatedCustomer ? "coaching" : cleanText(currentPhase),
  };
}

/* --------------------------- NEW USER DETECTION --------------------------- */

// A "new user" is detected when the request arrives with no prior conversation
// — no recent_messages and no last_summary. We deliberately do NOT check
// customer_status, because Make pre-sets it to "lead" for users routed through
// the user_new track even before this server is called, so it is not a
// reliable signal of "is this a returning user".
//
// recent_messages and last_summary are the true indicators: if both are empty,
// there has been no prior exchange between Emma and this user, regardless of
// whatever customer_status Make defaulted to.
//
// Returning user with both fields populated → false (Emma takes over).
// Truly new user → true (we send the hardcoded welcome reply and skip Emma).
//
// Source attribution (Airtable Bron field) is handled by Make/Airtable
// downstream from the original message body — not by this server.
function isNewUser({ recentMessages, lastSummary }) {
  const hasRecentMessages =
    Array.isArray(recentMessages) && recentMessages.length > 0;
  const hasLastSummary = Boolean(cleanText(lastSummary));

  return !hasRecentMessages && !hasLastSummary;
}

/* ------------------------------ CONTEXT BLOCK ----------------------------- */

function buildContextBlock({
  conversation_language,
  customer_country,
  customer_status,
  current_phase,
  goal,
  objections,
  last_summary,
  interested_in_program,
  interested_in_control,
  purchased_program,
  has_control,
  recent_messages,
  latest_user_message,
}) {
  const state = detectState({
    currentMessage: latest_user_message,
    recentMessages: recent_messages,
    lastSummary: last_summary,
    currentPhase: current_phase,
    customerStatus: customer_status,
  });

  const lastEmmaMessages = getLastEmmaMessages(recent_messages, 3);
  const lastUserMessages = getLastUserMessages(recent_messages, 3);

  const websiteLinkAlreadySent = hasPatternBeenSent(
    recent_messages,
    PLAIN_WEBSITE_LINK_PATTERN
  );
  const testimonialsLinkAlreadySent = hasPatternBeenSent(
    recent_messages,
    TESTIMONIALS_LINK_PATTERN
  );
  const programmaInfoLinkAlreadySent = hasPatternBeenSent(
    recent_messages,
    PROGRAMMA_INFO_LINK_PATTERN
  );
  const priceAlreadyMentioned = hasPriceBeenMentioned(recent_messages);
  const checkoutLinkAlreadySent = hasCheckoutLinkBeenSent(recent_messages);
  const whatsappGroupLinkAlreadySent = hasWhatsappGroupLinkBeenSent(recent_messages);
  const tasteAlreadyAsked = hasAskedTaste(recent_messages);
  const tasteAnswerReceived = hasReceivedTasteAnswer(recent_messages);
  const controlAnswerReceived = hasReceivedControlAnswer(recent_messages);
  const orderNumberAlreadyAsked = hasAskedOrderNumber(recent_messages);

  const validatedCustomer = isCustomerStatusValidated(
    customer_status,
    recent_messages
  );

  const context = {
    agent_name: "Emma",
    runtime_state: {
      ...state,
      website_link_already_sent: websiteLinkAlreadySent,
      testimonials_link_already_sent: testimonialsLinkAlreadySent,
      programma_info_link_already_sent: programmaInfoLinkAlreadySent,
      price_already_mentioned: priceAlreadyMentioned,
      checkout_link_already_sent: checkoutLinkAlreadySent,
      whatsapp_group_link_already_sent: whatsappGroupLinkAlreadySent,
      taste_already_asked: tasteAlreadyAsked,
      taste_answer_received: tasteAnswerReceived,
      control_answer_received: controlAnswerReceived,
      order_number_already_asked: orderNumberAlreadyAsked,
      conversation_language: cleanText(conversation_language) || "nl",
      customer_country: cleanText(customer_country) || "UNKNOWN",
      order_validation_server_side: true,
    },
    crm_memory: {
      customer_status: validatedCustomer ? "customer" : cleanText(customer_status),
      current_phase: validatedCustomer ? "coaching" : cleanText(current_phase),
      goal: clamp(goal, MAX_GOAL_CHARS),
      objections: clamp(objections, MAX_OBJECTIONS_CHARS),
      last_summary: clamp(last_summary, MAX_SUMMARY_CHARS),
      interested_in_program: clamp(interested_in_program, MAX_SHORT_FIELD_CHARS),
      interested_in_control: clamp(interested_in_control, MAX_SHORT_FIELD_CHARS),
      purchased_program: clamp(purchased_program, MAX_SHORT_FIELD_CHARS),
      has_control: clamp(has_control, MAX_SHORT_FIELD_CHARS),
    },
    latest_user_message: clamp(latest_user_message, 1000),
    recent_conversation_history: recent_messages.map((msg) => ({
      role: msg.role,
      message_text: clamp(msg.message_text, MAX_MESSAGE_CHARS),
      timestamp: cleanText(msg.timestamp),
    })),
    repetition_guard: {
      do_not_repeat_these_recent_emma_messages: lastEmmaMessages,
      last_user_messages_for_context_only: lastUserMessages,
      rules: [
        "Antwoord alleen op het nieuwste klantbericht.",
        "Antwoord ALTIJD in de gesprekstaal (conversation_language). Wissel nooit zelf van taal.",
        "Gebruik bekende CRM-data als achtergrond, niet als tekst om opnieuw op te sommen.",
        "Herhaal geen vraag, uitleg, prijs, testimonial-link, checkout-link of ordernummer-instructie die al in de recente Emma-berichten staat.",
        "Als iets al bekend is uit goal, objections, last_summary of recent_conversation_history: vraag er niet opnieuw naar.",
        "Als het gesprek bestaand is: stel jezelf niet opnieuw voor en gebruik geen startbericht.",
        "Zeg NOOIT welkom terug, goed dat je er weer bent of iets vergelijkbaars, en maak nooit opmerkingen over verstreken tijd. Begin altijd direct met je antwoord, alsof het gesprek gewoon doorloopt.",
        "Vraag NOOIT of de klant er nog is en jaag nooit op. Beoordeel een emoji of kort bericht uitsluitend vanuit de volledige gesprekscontext. Na een aangekondigde pauze opent een afsluitende bevestiging het gesprek niet opnieuw; de server handelt die beurt zelf af met alleen een groen hart. Follow-ups gebeuren handmatig, nooit door jou.",
        "Als website_link_already_sent true is: stuur de website-link en het freebies-blok NOOIT opnieuw, tenzij de klant er expliciet om vraagt. Geef bij twijfel kort persoonlijk advies in eigen woorden, zonder link.",
        "Als testimonials_link_already_sent true is: stuur de testimonials-link NIET opnieuw, tenzij de klant er expliciet om vraagt — verwijs in woorden naar de resultatenpagina.",
        "Als programma_info_link_already_sent true is: stuur de programma-uitleg link NIET opnieuw, tenzij de klant er expliciet om vraagt.",
        "Uitleggen betekent uitleggen in eigen woorden. Een link sturen is geen uitleg; stuur nooit een eerder gestuurde link opnieuw als vervanging van uitleg.",
        "Als price_already_mentioned true is: noem de prijs niet opnieuw, tenzij de klant ernaar vraagt.",
        "Vraag NOOIT naar het land van de klant. De checkout-links zijn universeel en openen automatisch in het juiste land met de juiste prijzen.",
        "Als checkout_link_already_sent true is: stuur geen nieuwe checkout-link, tenzij de klant er expliciet opnieuw om vraagt of expliciet een andere programma-, smaak- of Control-keuze maakt. Bij een gewijzigde keuze stuur je alleen de korte vervangende linkreactie zonder freebiesblok of betaaluitleg.",
        "Als whatsapp_group_link_already_sent true is: behandel de klant als gevalideerde klant en ga over naar coachingsmodus.",
        "In coachingsmodus: 100% coaching. Geen salesflow, geen prijs, geen checkout, geen upsell en geen productaanbevelingen uit jezelf. Verkoop alleen wanneer de klant er expliciet zelf om vraagt (bijvoorbeeld naar een specifiek product of als reactie op een broadcast-bericht). De WhatsApp-groep link alleen opnieuw delen als de klant er expliciet om vraagt.",
        "Ordervalidatie wordt server-side uitgevoerd. Emma mag nooit zelf een ordernummer goedkeuren of de WhatsApp-link zelfstandig delen.",
        "Gebruik nooit interne prompttermen zoals neutrale afsluiting, medische trigger, salesflow, runtime_state of repetition_guard in klantantwoorden.",
      ],
    },
  };

  // Validated customers get an explicit coaching banner ABOVE the JSON so
  // Emma cannot miss it (a single field buried in the JSON blob proved too
  // easy to overlook).
  const bannerLines = validatedCustomer
    ? [
        "!!! DEZE KLANT IS GEVALIDEERD KLANT — JE BENT 100% COACH !!!",
        "Geen verkoop, geen prijzen, geen programma's, geen upsells en geen checkout-links, tenzij de klant er expliciet zelf om vraagt (bijvoorbeeld naar een specifiek product of als reactie op een broadcast-bericht).",
        "Vraag NOOIT of de klant de website of de programma's al heeft bekeken.",
        "De website (nutritionworks.online) noem je alleen nog als recepten-tool om de klant tijdens het programma verder te helpen.",
        "Eindig je berichten NIET standaard met een vraag. Help de klant met waar ze mee komt; stel alleen een tegenvraag als die echt nodig is om goed te kunnen helpen.",
        "",
      ]
    : [];

  return [
    ...bannerLines,
    "RUNTIME CONTEXT VOOR EMMA",
    "Gebruik deze context als hoogste gespreksspecifieke input naast de system prompt.",
    "De context is feitelijk; herhaal hem niet letterlijk naar de klant.",
    "",
    JSON.stringify(context, null, 2),
  ].join("\n");
}

/* ----------------------------- JSON UTILITIES ----------------------------- */

function safeJsonParse(value) {
  if (!value || typeof value !== "string") return null;

  const trimmed = value.trim();

  try {
    return JSON.parse(trimmed);
  } catch {}

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    try {
      return JSON.parse(fencedMatch[1]);
    } catch {}
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {}
  }

  return null;
}

function extractOutputText(response) {
  if (cleanText(response?.output_text)) return cleanText(response.output_text);

  if (Array.isArray(response?.output)) {
    const textParts = [];

    for (const item of response.output) {
      if (!Array.isArray(item?.content)) continue;

      for (const contentItem of item.content) {
        if (
          contentItem?.type === "output_text" &&
          cleanText(contentItem?.text)
        ) {
          textParts.push(cleanText(contentItem.text));
        }
      }
    }

    return cleanText(textParts.join("\n"));
  }

  return "";
}

/* --------------- OPENAI PAUSE + INTAKE STATE CLASSIFIER ---------------- */
/* --------------------- OPENAI PAUSE STATE CLASSIFIER -------------------- */

async function classifyConversationPause({
  message,
  recentMessages,
  currentGoal,
  currentLastSummary,
  currentPhase,
  customerStatus,
  conversationLanguage,
  requestId,
  requestStartMs,
}) {
  const serverChecklistDetected = hasStep2ChecklistBeenSent(recentMessages);
  const serverFollowUpsAsked = countNaturalIntakeFollowUps(recentMessages);
  const fallback = {
    pause_context_active: false,
    current_message_type: "other",
    pause_anchor_id: "",
    pause_anchor_is_explicit: false,
    confidence: "low",
    intake_context_active: false,
    goal_context_clear: false,
    challenge_context_clear: false,
    checklist_sent: serverChecklistDetected,
    checklist_response_type: "not_applicable",
    direct_testimonials_request: false,
    suggested_follow_up: "",
    intake_confidence: "low",
    server_intake_followups_asked: serverFollowUpsAsked,
  };

  if (!openai || !Array.isArray(recentMessages) || recentMessages.length === 0) {
    return fallback;
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      pause_context_active: { type: "boolean" },
      current_message_type: {
        type: "string",
        enum: [
          "closing_acknowledgement",
          "substantive",
          "pause_announcement",
          "other",
        ],
      },
      pause_anchor_id: { type: "string" },
      pause_anchor_is_explicit: { type: "boolean" },
      confidence: {
        type: "string",
        enum: ["high", "medium", "low"],
      },
      intake_context_active: { type: "boolean" },
      goal_context_clear: { type: "boolean" },
      challenge_context_clear: { type: "boolean" },
      checklist_sent: { type: "boolean" },
      checklist_response_type: {
        type: "string",
        enum: [
          "meaningful_details",
          "explicit_no_more",
          "bare_acknowledgement",
          "question_or_objection",
          "cannot_elaborate",
          "not_applicable",
        ],
      },
      direct_testimonials_request: { type: "boolean" },
      suggested_follow_up: { type: "string" },
      intake_confidence: {
        type: "string",
        enum: ["high", "medium", "low"],
      },
    },
    required: [
      "pause_context_active",
      "current_message_type",
      "pause_anchor_id",
      "pause_anchor_is_explicit",
      "confidence",
      "intake_context_active",
      "goal_context_clear",
      "challenge_context_clear",
      "checklist_sent",
      "checklist_response_type",
      "direct_testimonials_request",
      "suggested_follow_up",
      "intake_confidence",
    ],
  };

  const systemPrompt = [
    "You are a strict multilingual conversation-state classifier for a WhatsApp health coach. You classify both temporary pauses and the early intake before testimonials.",
    "You are a strict multilingual temporary-pause classifier for a WhatsApp health coach.",
    "Do not reply to the customer. Return only the JSON required by the schema.",
    "Interpret the semantic meaning of the complete exchange in any language. Do not decide by matching isolated words, phrases, emojis, or a vocabulary list.",
    "pause_context_active is true when the current message contextually belongs to a previously announced temporary pause, especially when it merely closes or acknowledges that pause exchange.",
    "Classify the current customer message as closing_acknowledgement when it only acknowledges or closes that pause exchange and contains no new question, information, decision, or request that needs an answer.",
    "Classify it as substantive when it adds content that needs an answer, clearly resumes the discussion, or answers an unresolved sales or checkout question. An answer to an open product, taste, Control, payment, or order question is always substantive, even when very short.",
    "Classify it as pause_announcement when the current message itself announces that the customer is stopping now and will continue later.",
    "pause_anchor_id must be the exact id of the most recent customer history message that contextually announced the temporary pause. Return an empty string when no such announcement is relevant. Keep returning that anchor for substantive messages received within 30 minutes of it, so the server can prevent an immediate sales-flow restart. For a closing acknowledgement that still belongs to the pause exchange, return the anchor even when more than 30 minutes have passed.",
    "pause_anchor_is_explicit is true only when pause_anchor_id points to a real customer message that semantically announces stopping the conversation now and returning or continuing later. A message that merely finishes an intake answer, says there is no other relevant information, closes a topic, or ends the conversation is not a temporary-pause anchor. Do not use a phrase list; judge the complete exchange in any language.",
    "Use other when none of the categories is established. If the context is genuinely ambiguous, use low confidence.",
    "A short message or emoji is never enough by itself to establish a pause or closing acknowledgement; its role must follow from the surrounding conversation.",
    "For intake, intake_context_active is true only for a lead in the welcome/intake/checklist stage before the testimonials have been sent. It is false for validated customers and later sales, checkout or coaching exchanges.",
    "goal_context_clear is true only when the customer's desired health change or outcome is clear enough to reflect accurately in your own words. A greeting, request for information, emoji, loose fact or very broad wish with no usable direction is not enough.",
    "challenge_context_clear is true only when the customer's main current obstacle, symptom, struggle, pattern or relevant failed approach is clear enough to understand what makes the goal difficult. Repeating only the goal does not establish the challenge. This field may guide a natural pre-checklist question, but it never blocks progress after the checklist has been sent.",
    "Use the complete conversation plus CRM goal and summary. Message length never decides readiness: one rich answer may establish enough context immediately, while very little information may require at most two natural follow-up questions before the checklist.",
    "checklist_sent is true only when Emma has actually sent the mandatory personalised Step 2 health checklist before the current message. This may be a suggestion checklist with check marks or, when everything was already known, a check-marked confirmation summary. Do not confuse it with a freebies, programme, price or checkout list. When server_intake_signals.checklist_sent is true, checklist_sent MUST be true, regardless of your own detection.",
    "When checklist_sent is true, classify the current customer response as meaningful_details if it adds or specifically confirms relevant information; explicit_no_more if its meaning in the complete context is that the customer has no other relevant information, issues or additions; bare_acknowledgement if it only acknowledges or thanks without answering the checklist; question_or_objection if it asks something or raises a concern that must be answered first; cannot_elaborate if the customer does not know, cannot explain or does not want to elaborate; otherwise not_applicable.",
    "explicit_no_more is a semantic intent, not a literal phrase. Expressions such as 'this was everything' are examples only, never trigger words. Recognise any equivalent meaning in any language from the full context, including corrections that make clear the customer already said there is nothing further to add.",
    "When checklist_sent is false, use cannot_elaborate when the current message contextually communicates that the customer cannot, will not, or has nothing further to add to the missing intake information. Otherwise checklist_response_type is not_applicable.",
    "Once checklist_sent is true, never require a separate formal challenge answer. A meaningful response, explicit semantic no-more response, or inability/unwillingness to add more completes intake, unless a current question or objection first needs an answer.",
    "direct_testimonials_request is true only when the current customer explicitly asks to see customer results, experiences, stories or the testimonials page/link. Do not infer this from general curiosity or a request for product information. Before the checklist this request does not bypass intake; it only permits a resend when the testimonials were already shared earlier.",
    `suggested_follow_up must be one short, natural question in ${LANGUAGE_NAMES[conversationLanguage] || "the conversation language"} only when fewer than two pre-checklist follow-ups have been asked and context is still sparse, or when the first bare checklist acknowledgement needs one clarification. Ask only one thing, never claim that much is already known, never repeat the checklist, and do not use an emoji or emoticon. Otherwise return an empty string.`,
    "If the intake state is genuinely ambiguous, use low intake_confidence. Never invent a goal, challenge, checklist or meaningful answer.",
  ].join("\n");

  const history = recentMessages.slice(-20).map((msg, index) => ({
    id: `history_${index + 1}`,
    role: msg.role || "unknown",
    message_text: clamp(msg.message_text, 400),
    timestamp: cleanText(msg.timestamp),
  }));
  const userPayload = {
    conversation_language: cleanText(conversationLanguage) || "nl",
    customer_status: cleanText(customerStatus),
    current_phase: cleanText(currentPhase),
    crm_goal: clamp(currentGoal, MAX_GOAL_CHARS),
    crm_last_summary: clamp(currentLastSummary, MAX_SUMMARY_CHARS),
    server_intake_signals: {
      checklist_sent: serverChecklistDetected,
      follow_up_questions_asked: Math.min(2, serverFollowUpsAsked),
    },
    recent_conversation: history,
    current_customer_message: {
      id: "current",
      role: "user",
      message_text: clamp(message, 1000),
      received_at: new Date(requestStartMs || Date.now()).toISOString(),
    },
  };

  const controller = new AbortController();
  const timeoutMs = Number.isFinite(PAUSE_CLASSIFIER_TIMEOUT_MS)
    ? Math.max(250, PAUSE_CLASSIFIER_TIMEOUT_MS)
    : 5000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  const model =
    process.env.OPENAI_PAUSE_MODEL ||
    process.env.OPENAI_EXTRACTION_MODEL ||
    "gpt-4o-mini";

  console.log(
    JSON.stringify({
      diag: true,
      request_id: requestId,
      event: "PAUSE_CLASSIFIER_START",
      elapsed_ms: requestStartMs ? startedAt - requestStartMs : null,
      timestamp_ms: startedAt,
      model,
      history_count: history.length,
      timestamps_present: history.filter((item) => item.timestamp).length,
    })
  );

  try {
    const response = await openai.responses.create(
      {
        model,
        store: false,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: systemPrompt }],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: JSON.stringify(userPayload) }],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "conversation_pause_state",
            strict: true,
            schema,
          },
        },
      },
      { signal: controller.signal }
    );

    const rawText = extractOutputText(response);
    const parsed = safeJsonParse(rawText);
    const messageTypes = new Set([
      "closing_acknowledgement",
      "substantive",
      "pause_announcement",
      "other",
    ]);
    const confidenceLevels = new Set(["high", "medium", "low"]);
    const checklistResponseTypes = new Set(
      schema.properties.checklist_response_type.enum
    );
    const result = {
      pause_context_active: parsed?.pause_context_active === true,
      current_message_type: messageTypes.has(parsed?.current_message_type)
        ? parsed.current_message_type
        : "other",
      pause_anchor_id: /^history_\d+$/.test(cleanText(parsed?.pause_anchor_id))
        ? cleanText(parsed.pause_anchor_id)
        : "",
      pause_anchor_is_explicit: parsed?.pause_anchor_is_explicit === true,
      confidence: confidenceLevels.has(parsed?.confidence)
        ? parsed.confidence
        : "low",
      intake_context_active: parsed?.intake_context_active === true,
      goal_context_clear: parsed?.goal_context_clear === true,
      challenge_context_clear: parsed?.challenge_context_clear === true,
      checklist_sent:
        serverChecklistDetected || parsed?.checklist_sent === true,
      checklist_response_type: checklistResponseTypes.has(
        parsed?.checklist_response_type
      )
        ? parsed.checklist_response_type
        : "not_applicable",
      direct_testimonials_request:
        parsed?.direct_testimonials_request === true,
      suggested_follow_up: clamp(parsed?.suggested_follow_up, 240),
      intake_confidence: confidenceLevels.has(parsed?.intake_confidence)
        ? parsed.intake_confidence
        : "low",
      server_intake_followups_asked: serverFollowUpsAsked,
    };

    console.log(
      JSON.stringify({
        diag: true,
        request_id: requestId,
        event: "PAUSE_CLASSIFIER_COMPLETE",
        elapsed_ms: requestStartMs ? Date.now() - requestStartMs : null,
        timestamp_ms: Date.now(),
        duration_ms: Date.now() - startedAt,
        ...result,
      })
    );

    return result;
  } catch (error) {
    console.error("PAUSE CLASSIFIER ERROR:", error?.message || error);
    console.log(
      JSON.stringify({
        diag: true,
        request_id: requestId,
        event: "PAUSE_CLASSIFIER_ERROR",
        elapsed_ms: requestStartMs ? Date.now() - requestStartMs : null,
        timestamp_ms: Date.now(),
        duration_ms: Date.now() - startedAt,
        error_message: error?.message || String(error),
      })
    );
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------- OPENAI CHECKOUT CLASSIFIER ---------------------- */

async function classifyCheckoutState({
  message,
  recentMessages,
  customerCountry,
  requestId,
  requestStartMs,
}) {
  const fallback = {
    checkout_context_active: false,
    checkout_message_type: "other",
    checkout_program: "",
    checkout_taste: "",
    checkout_control: "",
    checkout_payment_mode: "unknown",
    checkout_ambiguous_field: "none",
    checkout_confidence: "low",
  };

  if (!openai || !Array.isArray(recentMessages) || recentMessages.length === 0) {
    return fallback;
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      checkout_context_active: { type: "boolean" },
      checkout_message_type: {
        type: "string",
        enum: [
          "selection_update",
          "selection_ambiguous",
          "program_comparison",
          "link_resend_request",
          "technical_cart_issue",
          "technical_issue_persisting",
          "payment_status_uncertain",
          "question_or_objection",
          "other",
        ],
      },
      checkout_program: {
        type: "string",
        enum: ["Basic", "Beauty", "Deluxe", "Exclusive", ""],
      },
      checkout_taste: {
        type: "string",
        enum: ["vanilla", "chocolate", "mix", ""],
      },
      checkout_control: {
        type: "string",
        enum: ["yes", "no", "unavailable", ""],
      },
      checkout_payment_mode: {
        type: "string",
        enum: ["france_4x", "one_time", "unknown"],
      },
      checkout_ambiguous_field: {
        type: "string",
        enum: ["program", "taste", "control", "taste_and_control", "none"],
      },
      checkout_confidence: {
        type: "string",
        enum: ["high", "medium", "low"],
      },
    },
    required: [
      "checkout_context_active",
      "checkout_message_type",
      "checkout_program",
      "checkout_taste",
      "checkout_control",
      "checkout_payment_mode",
      "checkout_ambiguous_field",
      "checkout_confidence",
    ],
  };

  const systemPrompt = [
    "You are a strict multilingual checkout-state classifier for a WhatsApp health coach.",
    "Do not reply to the customer. Return only the JSON required by the schema.",
    "Interpret the complete conversation semantically in any language. Do not decide from isolated words or a language-specific vocabulary list.",
    "This classifier only manages checkout for the Complete programmes Basic, Beauty, Deluxe and Exclusive. For unrelated products or ordinary sales discussion, return checkout_context_active false and other.",
    "checkout_context_active is true only when the customer is clearly in an ordering/checkout exchange, changes a selection after receiving a checkout link, asks for that checkout link again, or reports a technical problem with that checkout/payment.",
    "checkout_context_active is true only when the customer is clearly in an ordering/checkout exchange, changes a selection after receiving a checkout link, asks for that checkout link again, or reports a technical problem with that checkout/payment. Merely discussing, comparing or doubting between programmes is not an active checkout.",
    "Return the customer's CURRENT intended programme, Complete taste and Control choice after applying the newest explicit change. The newest explicit customer choice overrides every older choice.",
    "When only one selection changes, preserve the other selections from the established conversation or the last_checkout_selection. Never silently erase an unchanged selection.",
    "Never infer an unanswered choice. If a required choice is missing, return an empty string. A vague or ambiguous answer uses selection_ambiguous and identifies only the ambiguous field.",
    "selection_update means the current customer message explicitly chooses, answers or changes at least one checkout selection. question_or_objection means the customer asks for information or expresses doubt and needs a normal answer before checkout can advance.",
    "Never infer an unanswered choice. If a required choice is missing, return an empty string. selection_ambiguous is reserved for an unclear answer to an already open technical checkout choice; it never means that a customer is deciding between programmes or asking which programme fits.",
    "selection_update means the current customer message makes a definite choice, answers an open checkout choice, or explicitly changes at least one checkout selection. Naming a programme while comparing options or expressing doubt is not a selection update.",
    "program_comparison means the customer is considering, comparing or doubting between one or more programmes, wants a recommendation, asks about differences, or has not made a definitive choice. This classification takes priority over selection_ambiguous whenever programme choice requires advice. Return checkout_context_active false, leave checkout_program empty and use checkout_ambiguous_field none so Emma can answer normally.",
    "question_or_objection means the customer asks for other information or expresses another doubt that needs a normal answer before checkout can advance.",
    "link_resend_request means the customer explicitly asks to receive the same checkout link again, for example because it was lost.",
    "technical_cart_issue means the cart or checkout page does not open/load correctly and the customer has not yet been given the close-browser-and-reopen-link instruction in the supplied history.",
    "technical_issue_persisting means that instruction was already given and the customer says the cart or checkout still does not work.",
    "payment_status_uncertain means the customer may already have attempted payment and it is unclear whether money was charged or the order/payment completed. Never classify this as a simple cart-opening issue.",
    "For customer_country PT, Control is unavailable: use unavailable unless the current customer explicitly tries to add Control, in which case return yes so the server can explain that it cannot be added.",
    "For customer_country FR, france_4x is the default. Use one_time only when the customer explicitly chose payment in one go or the last checkout selection was already one_time and the customer only changes another selection.",
    "For every country outside FR use one_time. This field describes the checkout-link family, not whether Klarna is used inside the universal checkout.",
    "If context is incomplete or genuinely uncertain, use low confidence. Do not invent a programme, taste, Control answer or technical problem.",
  ].join("\n");

  const history = recentMessages.slice(-20).map((msg, index) => ({
    id: `history_${index + 1}`,
    role: msg.role || "unknown",
    message_text: clamp(msg.message_text, 500),
    timestamp: cleanText(msg.timestamp),
  }));
  const previousCheckoutLink = findLastEmmaCheckoutLink(recentMessages, "");
  const previousCheckoutSelection = parseCheckoutLinkSKU(previousCheckoutLink);
  const userPayload = {
    customer_country: (customerCountry || "UNKNOWN").toUpperCase(),
    last_checkout_link: previousCheckoutLink,
    last_checkout_selection: previousCheckoutSelection || null,
    recent_conversation: history,
    current_customer_message: {
      role: "user",
      message_text: clamp(message, 1000),
      received_at: new Date(requestStartMs || Date.now()).toISOString(),
    },
  };

  const controller = new AbortController();
  const timeoutMs = Number.isFinite(CHECKOUT_CLASSIFIER_TIMEOUT_MS)
    ? Math.max(250, CHECKOUT_CLASSIFIER_TIMEOUT_MS)
    : 6000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  const model =
    process.env.OPENAI_CHECKOUT_MODEL ||
    process.env.OPENAI_EXTRACTION_MODEL ||
    "gpt-4o-mini";

  console.log(
    JSON.stringify({
      diag: true,
      request_id: requestId,
      event: "CHECKOUT_CLASSIFIER_START",
      elapsed_ms: requestStartMs ? startedAt - requestStartMs : null,
      timestamp_ms: startedAt,
      model,
      history_count: history.length,
      has_previous_checkout_link: Boolean(previousCheckoutLink),
    })
  );

  try {
    const response = await openai.responses.create(
      {
        model,
        store: false,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: systemPrompt }],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: JSON.stringify(userPayload) }],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "checkout_conversation_state",
            strict: true,
            schema,
          },
        },
      },
      { signal: controller.signal }
    );

    const parsed = safeJsonParse(extractOutputText(response));
    const messageTypes = new Set(schema.properties.checkout_message_type.enum);
    const paymentModes = new Set(schema.properties.checkout_payment_mode.enum);
    const ambiguousFields = new Set(schema.properties.checkout_ambiguous_field.enum);
    const confidenceLevels = new Set(schema.properties.checkout_confidence.enum);
    const result = {
      checkout_context_active: parsed?.checkout_context_active === true,
      checkout_message_type: messageTypes.has(parsed?.checkout_message_type)
        ? parsed.checkout_message_type
        : "other",
      checkout_program: normalizeCheckoutProgram(parsed?.checkout_program),
      checkout_taste: normalizeCheckoutTaste(parsed?.checkout_taste),
      checkout_control: normalizeCheckoutControl(parsed?.checkout_control),
      checkout_payment_mode: paymentModes.has(parsed?.checkout_payment_mode)
        ? parsed.checkout_payment_mode
        : "unknown",
      checkout_ambiguous_field: ambiguousFields.has(parsed?.checkout_ambiguous_field)
        ? parsed.checkout_ambiguous_field
        : "none",
      checkout_confidence: confidenceLevels.has(parsed?.checkout_confidence)
        ? parsed.checkout_confidence
        : "low",
    };

    console.log(
      JSON.stringify({
        diag: true,
        request_id: requestId,
        event: "CHECKOUT_CLASSIFIER_COMPLETE",
        elapsed_ms: requestStartMs ? Date.now() - requestStartMs : null,
        timestamp_ms: Date.now(),
        duration_ms: Date.now() - startedAt,
        ...result,
      })
    );
    return result;
  } catch (error) {
    console.error("CHECKOUT CLASSIFIER ERROR:", error?.message || error);
    console.log(
      JSON.stringify({
        diag: true,
        request_id: requestId,
        event: "CHECKOUT_CLASSIFIER_ERROR",
        elapsed_ms: requestStartMs ? Date.now() - requestStartMs : null,
        timestamp_ms: Date.now(),
        duration_ms: Date.now() - startedAt,
        error_message: error?.message || String(error),
      })
    );
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------- OPENAI CRM EXTRACTION ------------------------- */

async function getStructuredUpdates({
  message,
  customerStatus,
  currentPhase,
  currentGoal,
  currentObjections,
  currentLastSummary,
  currentInterestedInProgram,
  currentInterestedInControl,
  currentPurchasedProgram,
  currentHasControl,
  recentMessages,
  requestId,
  requestStartMs,
}) {
  const diag = (event, extra = {}) => {
    const now = Date.now();
    console.log(
      JSON.stringify(
        {
          diag: true,
          request_id: requestId,
          event,
          elapsed_ms: requestStartMs ? now - requestStartMs : null,
          timestamp_ms: now,
          ...extra,
        },
        null,
        2
      )
    );
  };

  const emptyResult = {
    goal_update: "",
    objections_update: "",
    last_summary_update: "",
    current_phase_update: "",
    interested_in_program_update: "",
    interested_in_control_update: "",
    purchased_program_update: "",
    has_control_update: "",
  };

  if (!openai) {
    console.error("OPENAI CONFIG ERROR: OPENAI_API_KEY ontbreekt");
    return emptyResult;
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      goal_update: { type: "string" },
      objections_update: { type: "string" },
      last_summary_update: { type: "string" },
      current_phase_update: { type: "string" },
      interested_in_program_update: { type: "string" },
      interested_in_control_update: { type: "string" },
      purchased_program_update: { type: "string" },
      has_control_update: { type: "string" },
    },
    required: [
      "goal_update",
      "objections_update",
      "last_summary_update",
      "current_phase_update",
      "interested_in_program_update",
      "interested_in_control_update",
      "purchased_program_update",
      "has_control_update",
    ],
  };

  const systemPrompt = [
    "Je bent een strikte CRM-extractor voor een WhatsApp salesgesprek voor Nutrition Works.",
    "Je taak is NIET om te antwoorden op de gebruiker.",
    "Je analyseert het nieuwste gebruikersbericht in de context van het hele gesprek en de bestaande CRM-data.",
    "Je geeft uitsluitend geldige JSON terug volgens het schema. Schrijf alle veldwaarden in het Nederlands, ook wanneer het gesprek in een andere taal wordt gevoerd.",
    "Verzin niets. Vul nooit iets in dat niet uit het gesprek volgt.",
    "",
    "REGELS PER VELD:",
    "",
    "goal_update — De VOLLEDIGE, bijgewerkte doelomschrijving van de klant.",
    "- Geef de complete bijgewerkte goal terug, met bestaande info plus eventuele nieuwe info uit het laatste bericht.",
    "- Max 300 tekens.",
    "- Als er werkelijk niets is veranderd ten opzichte van current_goal: lege string.",
    "",
    "objections_update — ALLE bezwaren die de klant tot nu toe heeft geuit, als één samenhangende tekst.",
    "- Geef de complete bijgewerkte objections terug, met bestaande bezwaren plus eventuele nieuwe bezwaren uit het laatste bericht.",
    "- Max 400 tekens.",
    "- Als er werkelijk niets is veranderd ten opzichte van current_objections: lege string.",
    "",
    "last_summary_update — Een korte, lopende synthese van wat we tot nu toe weten over de klant.",
    "- Dit is GEEN herhaling van latest_user_message. Het is een lopende werk-samenvatting van het hele gesprek tot dusver.",
    "- Schrijf altijd iets zodra er één feit is om vast te leggen (naam, leeftijd, doel, situatie, twijfel, fase). Begin klein en bouw op.",
    "- Integreer bestaande info uit current_last_summary met nieuwe info uit het laatste bericht. Herformuleer waar nodig.",
    "- Eén tot drie zinnen vroeg in het gesprek is prima. Langer wordt het vanzelf naarmate er meer bekend wordt.",
    "- Bedoeld om volgende turns context te geven over wie de klant is, wat ze wil, en waar we staan in het gesprek.",
    "- Max 500 tekens.",
    "- Alleen lege string als er werkelijk niets te onthouden valt (bijv. één enkel 'hoi' en verder niets).",
    "",
    "current_phase_update — De gespreksfase op basis van wat er tot nu toe is besproken.",
    "- Een van: intake / verdieping / analyse / advies / commitment / presentatie / closing / checkout-bevestiging / checkout / coaching / na_aankoop.",
    "- coaching of na_aankoop is alleen wanneer de klant al gevalideerd klant is (customer_status = customer).",
    "- Geef de huidige fase terug zodra die verandert ten opzichte van current_phase.",
    "- Als de fase niet duidelijk verandert: lege string.",
    "",
    "interested_in_program_update — Welk specifiek programma (Basic, Beauty, Deluxe of Exclusive) de klant zelf expliciet noemt of kiest.",
    "interested_in_program_update — Voor welk specifiek programma (Basic, Beauty, Deluxe of Exclusive) de klant een duidelijke afzonderlijke interesse, voorkeur of keuze uitspreekt.",
    "- Geldige waarden: Basic / Beauty / Deluxe / Exclusive / (lege string).",
    "- Vul ALLEEN in als de klant zelf de exacte programmanaam (Basic, Beauty, Deluxe of Exclusive) noemt of kiest.",
    "- Alleen een programmanaam noemen is niet automatisch een keuze. Vul alleen in wanneer uit de volledige context een duidelijke interesse, voorkeur of keuze voor precies één programma blijkt.",
    "- Vergelijkt de klant meerdere programma's, twijfelt die tussen meerdere opties of vraagt die welk programma past, dan is nog geen afzonderlijk programma gekozen: retourneer een lege string.",
    "- Algemene koopintentie, het bestellen van Control, of interesse in afvallen tellen NIET als programma-interesse.",
    "- Kies nooit een default programma. Als geen programmanaam letterlijk is genoemd: lege string. Verzin nooit een programma.",
    "- Kies nooit zelf één programma uit meerdere genoemde opties en neem nooit Emma's advies over als klantkeuze. Verzin nooit een programma.",
    "",
    "interested_in_control_update — Of de klant aantoonbaar positieve interesse toont in Control.",
    "- Geldige waarden: ja / (lege string).",
    "- Vul \"ja\" alleen in bij een positieve uitspraak of keuze van de klant, inclusief een kort contextueel antwoord zoals 'ja' op een openstaande Control-vraag.",
    "- Een vermelding of suggestie van Emma is nooit voldoende.",
    "- Negatieve antwoorden zoals 'nee', 'geen Control' en 'laat maar' geven altijd een lege string.",
    "",
    "purchased_program_update — Welk specifiek programma (Basic, Beauty, Deluxe of Exclusive) de klant heeft besteld.",
    "- Geldige waarden: Basic / Beauty / Deluxe / Exclusive / (lege string).",
    "- Vul ALLEEN in als de klant in haar bericht expliciet de naam van het bestelde programma noemt.",
    "- Algemene koopintentie of het bestellen van Control telt NIET als programma-aankoop.",
    "- Bij geen expliciete vermelding van een programmanaam in de aankoop: lege string. Verzin nooit een aankoop.",
    "",
    "has_control_update — Of de klant Control heeft besteld als onderdeel van haar bestelling.",
    "- Geldige waarden: ja / nee / (lege string).",
    "- Vul \"ja\" alleen in als de klant expliciet vermeldt dat Control onderdeel is van haar bestelling.",
    "- Vul \"nee\" alleen als de klant expliciet aangeeft dat Control NIET in haar bestelling zit.",
    "- Bij geen expliciete vermelding van Control in de aankoop: lege string. Verzin geen aankoop.",
    "",
    "Belangrijk: voor elk veld geldt — als er niets is veranderd, retourneer een lege string.",
  ].join("\n");

  const userPayload = {
    latest_user_message: clamp(message, 1000),
    current_customer_status: cleanText(customerStatus),
    current_phase: cleanText(currentPhase),
    current_goal: clamp(currentGoal, MAX_GOAL_CHARS),
    current_objections: clamp(currentObjections, MAX_OBJECTIONS_CHARS),
    current_last_summary: clamp(currentLastSummary, MAX_SUMMARY_CHARS),
    current_interested_in_program: clamp(currentInterestedInProgram, MAX_SHORT_FIELD_CHARS),
    current_interested_in_control: clamp(currentInterestedInControl, MAX_SHORT_FIELD_CHARS),
    current_purchased_program: clamp(currentPurchasedProgram, MAX_SHORT_FIELD_CHARS),
    current_has_control: clamp(currentHasControl, MAX_SHORT_FIELD_CHARS),
    recent_messages: recentMessages.slice(-EXTRACTOR_CONTEXT_MESSAGES).map((msg) => ({
      role: msg.role || "unknown",
      message_text: clamp(msg.message_text, 250),
    })),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  const openaiStartMs = Date.now();
  diag("OPENAI_REQUEST_START", {
    model: process.env.OPENAI_EXTRACTION_MODEL || "gpt-4o-mini",
    payload_size_bytes: JSON.stringify(userPayload).length,
    system_prompt_size_bytes: systemPrompt.length,
  });

  try {
    const response = await openai.responses.create(
      {
        model: process.env.OPENAI_EXTRACTION_MODEL || "gpt-4o-mini",
        store: false,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: systemPrompt }],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: JSON.stringify(userPayload) }],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "memory_updates",
            strict: true,
            schema,
          },
        },
      },
      { signal: controller.signal }
    );

    const rawText = extractOutputText(response);
    const parsed = safeJsonParse(rawText);

    diag("OPENAI_REQUEST_COMPLETE", {
      duration_ms: Date.now() - openaiStartMs,
      raw_text_size_bytes: typeof rawText === "string" ? rawText.length : 0,
      parsed_ok: Boolean(parsed && typeof parsed === "object"),
    });

    if (!parsed || typeof parsed !== "object") {
      console.error("OPENAI EXTRACTION ERROR: ongeldige JSON output", rawText);
      return emptyResult;
    }

    return {
      goal_update: cleanText(parsed.goal_update),
      objections_update: cleanText(parsed.objections_update),
      last_summary_update: cleanText(parsed.last_summary_update),
      current_phase_update: normalizePhaseName(parsed.current_phase_update),
      interested_in_program_update: normalizeProgramName(parsed.interested_in_program_update),
      interested_in_control_update: normalizeBinaryFlag(parsed.interested_in_control_update),
      purchased_program_update: normalizeProgramName(parsed.purchased_program_update),
      has_control_update: normalizeBinaryFlag(parsed.has_control_update),
    };
  } catch (error) {
    diag("OPENAI_REQUEST_ERROR", {
      duration_ms: Date.now() - openaiStartMs,
      error_message: error?.message || String(error),
    });
    console.error("OPENAI EXTRACTION ERROR:", error?.message || error);
    return emptyResult;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------- INTAKE TURN ENFORCEMENT ------------------------- */

function buildIntakeTurnGuard({ decision, classification }) {
  const action = cleanText(decision?.action);
  const commonHold =
    "Stuur deze beurt GEEN testimonials-link en ga nog niet naar Stap 3.";

  if (action === "contextual_after_checklist") {
    return [
      "Het verplichte Stap 2-checklistbericht is aantoonbaar al verstuurd. Herhaal de checklist niet en stel niet alsnog een aparte formele vraag naar doel of uitdaging.",
      "Beoordeel het nieuwste klantbericht nu zelf contextueel vanuit het volledige gesprek, zonder woordenlijst of vaste formulering.",
      "Voegt de klant inhoudelijk informatie toe, bevestigt die een checklistpunt, blijkt dat er niets relevants meer toe te voegen is, of kan of wil de klant niet verder toelichten: rond Stap 2 organisch af en stuur nu het vaste testimonialbericht.",
      "Is het uitsluitend een losse bevestiging zonder inhoud en is nog geen verduidelijking gesteld: stel maximaal één korte natuurlijke verduidelijkingsvraag, zonder de checklist te herhalen.",
      "Bevat het bericht een actuele vraag of bezwaar: beantwoord dat eerst. Stuur nooit alleen een algemeen bedankje waardoor het gesprek stilvalt.",
    ].join("\n");
  }

  if (
    action === "allow_testimonials" ||
    action === "allow_testimonials_resend"
  ) {
    return action === "allow_testimonials_resend"
      ? "De klant vraagt nu expliciet opnieuw om de testimonials. Je mag de testimonials-link deze beurt opnieuw sturen."
      : "Het verplichte checklistmoment is afgerond en de reactie van de klant is contextueel voldoende. Vraag niet alsnog apart naar een doel of uitdaging, herhaal de checklist niet en stuur nu het vaste testimonialbericht.";
  }

  if (action === "testimonials_already_sent") {
    return "De testimonials zijn al gedeeld en de klant vraagt niet expliciet om de link. Stuur de link niet opnieuw.";
  }

  if (action === "ask_goal") {
    return [
      commonHold,
      "Het doel van de klant is nog niet contextueel duidelijk genoeg.",
      "Reageer warm op alleen wat echt bekend is en stel precies één korte, makkelijke vraag naar wat de klant wil veranderen of bereiken.",
      "Dit is één van maximaal twee natuurlijke vervolgvragen vóór het checklistmoment.",
      'Zeg niet "hier kan ik al veel mee" en stuur de checklist nog niet.',
      cleanText(classification?.suggested_follow_up)
        ? `Passende vervolgvraag: ${cleanText(classification.suggested_follow_up)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (action === "ask_challenge") {
    return [
      commonHold,
      "Het doel is duidelijk, maar de grootste huidige uitdaging nog niet.",
      "Bevestig het bekende doel kort en stel precies één makkelijke vraag naar wat dit doel nu vooral lastig maakt.",
      "Dit is één van maximaal twee natuurlijke vervolgvragen vóór het checklistmoment.",
      'Zeg niet "hier kan ik al veel mee" en stuur de checklist nog niet.',
      cleanText(classification?.suggested_follow_up)
        ? `Passende vervolgvraag: ${cleanText(classification.suggested_follow_up)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (action === "send_checklist" || action === "send_checklist_support") {
    return [
      commonHold,
      action === "send_checklist_support"
        ? "De klant kan of wil de ontbrekende informatie niet verder uitleggen. Gebruik nu het verplichte Stap 2-checklistbericht als vriendelijke herkenningshulp, zonder te doen alsof je al genoeg weet."
        : "Er is genoeg context of het maximum van twee natuurlijke vervolgvragen is bereikt. Het verplichte Stap 2-checklistbericht is nog niet verstuurd. Stuur dat bericht nu en stel niet eerst nog een losse intakevraag.",
      "Maak de checklist contextueel: verwijder elke suggestie die de klant inhoudelijk al heeft genoemd, ook als daardoor maar één suggestie overblijft.",
      "Zijn alle suggesties al bekend, gebruik dan een korte ✅ bevestigingschecklist met uitsluitend werkelijk gedeelde informatie en vraag alleen of er nog iets ontbreekt.",
      "Voeg nooit een bekend onderwerp opnieuw toe om de lijst langer te maken.",
    ].join("\n");
  }

  if (action === "clarify_checklist") {
    return [
      commonHold,
      "De klant stuurde alleen een contextuele bevestiging of bedankje na de checklist; dit is geen inhoudelijk checklistantwoord.",
      "Stel precies één korte, natuurlijke vraag of de klant nog iets uit de checklist herkent of dat het eerder gedeelde het belangrijkste is.",
      "Herhaal de checklist niet. Na deze ene verduidelijking volgt geen tweede verduidelijkingsronde.",
      cleanText(classification?.suggested_follow_up)
        ? `Passende vervolgvraag: ${cleanText(classification.suggested_follow_up)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (action === "answer_and_hold") {
    return [
      commonHold,
      "De klant heeft een actuele vraag of een bezwaar. Beantwoord dat eerst kort en behulpzaam.",
      "Combineer het antwoord niet met testimonials en duw de salesflow deze beurt niet verder.",
    ].join("\n");
  }

  if (action === "hold_without_pressure") {
    return [
      commonHold,
      "De klant kan of wil nu niet verder toelichten. Respecteer dat, reageer kort en warm en stel niet opnieuw dezelfde intakevraag.",
    ].join("\n");
  }

  if (action === "hold_uncertain" || action === "hold_intake") {
    return [
      commonHold,
      "De server kon niet betrouwbaar bevestigen dat alle intakevoorwaarden zijn voltooid. Blijf bij de huidige inhoud en ga alleen verder volgens Stap 2.",
    ].join("\n");
  }

  return "";
}

const INTAKE_RECOVERY_REPLIES = {
  nl: {
    ask_goal: "Wat zou je op dit moment het liefst willen veranderen of bereiken? 😊",
    ask_challenge: "Wat maakt dat op dit moment vooral lastig voor je? 😊",
    clarify_checklist:
      "Herken je nog iets uit het lijstje, of is wat je al vertelde het belangrijkste voor je? 😊",
    send_checklist:
      "Dankjewel voor het delen 🙏 Is er naast wat je al vertelde nog iets dat belangrijk is om mee te nemen? 😊",
    hold: "Dankjewel voor het delen 🙏",
  },
  en: {
    ask_goal: "What would you most like to change or achieve right now? 😊",
    ask_challenge: "What is making that especially difficult for you right now? 😊",
    clarify_checklist:
      "Do you recognise anything else from the list, or is what you already shared the main thing for you? 😊",
    send_checklist:
      "Thank you for sharing that 🙏 Is there anything else that feels important to include? 😊",
    hold: "Thank you for sharing that 🙏",
  },
  fr: {
    ask_goal: "Qu’aimerais-tu surtout changer ou atteindre en ce moment ? 😊",
    ask_challenge: "Qu’est-ce qui rend cela surtout difficile pour toi en ce moment ? 😊",
    clarify_checklist:
      "Est-ce que tu te reconnais dans un autre point de la liste, ou est-ce que ce que tu as déjà partagé est le plus important pour toi ? 😊",
    send_checklist:
      "Merci de l’avoir partagé 🙏 Y a-t-il autre chose d’important à prendre en compte ? 😊",
    hold: "Merci de l’avoir partagé 🙏",
  },
  de: {
    ask_goal: "Was möchtest du im Moment am liebsten verändern oder erreichen? 😊",
    ask_challenge: "Was macht das im Moment besonders schwierig für dich? 😊",
    clarify_checklist:
      "Erkennst du dich noch in einem Punkt aus der Liste wieder, oder ist das, was du schon erzählt hast, für dich das Wichtigste? 😊",
    send_checklist:
      "Danke, dass du das geteilt hast 🙏 Gibt es noch etwas, das wir unbedingt berücksichtigen sollten? 😊",
    hold: "Danke, dass du das geteilt hast 🙏",
  },
  it: {
    ask_goal: "Che cosa vorresti soprattutto cambiare o raggiungere in questo momento? 😊",
    ask_challenge: "Che cosa rende questo obiettivo particolarmente difficile per te in questo momento? 😊",
    clarify_checklist:
      "Ti riconosci in qualche altro punto dell’elenco, oppure ciò che hai già raccontato è la cosa più importante per te? 😊",
    send_checklist:
      "Grazie per averlo condiviso 🙏 C’è qualcos’altro di importante da tenere in considerazione? 😊",
    hold: "Grazie per averlo condiviso 🙏",
  },
  es: {
    ask_goal: "¿Qué es lo que más te gustaría cambiar o conseguir ahora mismo? 😊",
    ask_challenge: "¿Qué es lo que hace que eso te resulte especialmente difícil ahora mismo? 😊",
    clarify_checklist:
      "¿Te identificas con algún otro punto de la lista o lo que ya contaste es lo más importante para ti? 😊",
    send_checklist:
      "Gracias por compartirlo 🙏 ¿Hay algo más importante que debamos tener en cuenta? 😊",
    hold: "Gracias por compartirlo 🙏",
  },
  pt: {
    ask_goal: "O que gostarias mais de mudar ou alcançar neste momento? 😊",
    ask_challenge: "O que está a tornar isso especialmente difícil para ti neste momento? 😊",
    clarify_checklist:
      "Identificas-te com mais algum ponto da lista ou o que já partilhaste é o mais importante para ti? 😊",
    send_checklist:
      "Obrigada por partilhares 🙏 Há mais alguma coisa importante que devamos ter em conta? 😊",
    hold: "Obrigada por partilhares 🙏",
  },
  pl: {
    ask_goal: "Co najbardziej chciałabyś teraz zmienić lub osiągnąć? 😊",
    ask_challenge: "Co sprawia, że jest to teraz dla Ciebie szczególnie trudne? 😊",
    clarify_checklist:
      "Czy rozpoznajesz u siebie coś jeszcze z tej listy, czy najważniejsze jest to, o czym już napisałaś? 😊",
    send_checklist:
      "Dziękuję, że się tym podzieliłaś 🙏 Czy jest jeszcze coś ważnego, co powinnam uwzględnić? 😊",
    hold: "Dziękuję, że się tym podzieliłaś 🙏",
  },
};

function enforceTestimonialsGate({
  reply,
  intakeDecision,
  intakeClassification,
  language,
}) {
  const text = cleanReplyText(reply);
  if (!TESTIMONIALS_LINK_PATTERN.test(text)) {
    return { reply: text, blocked: false };
  }

  if (intakeDecision?.testimonials_allowed === true) {
    return { reply: text, blocked: false };
  }

  const action = cleanText(intakeDecision?.action);
  if (action === "testimonials_already_sent") {
    const withoutLink = cleanReplyText(
      text.replace(/https?:\/\/nutritionworks\.online\/?#testimonials\S*/gi, "")
    );
    return {
      reply:
        withoutLink ||
        (INTAKE_RECOVERY_REPLIES[language] || INTAKE_RECOVERY_REPLIES.nl).hold,
      blocked: true,
    };
  }

  const messages =
    INTAKE_RECOVERY_REPLIES[language] || INTAKE_RECOVERY_REPLIES.nl;
  const suggested = cleanReplyText(intakeClassification?.suggested_follow_up);
  let recovery = "";
  if (["ask_goal", "ask_challenge", "clarify_checklist"].includes(action)) {
    recovery = suggested || messages[action];
  } else if (["send_checklist", "send_checklist_support"].includes(action)) {
    recovery = messages.send_checklist;
  } else {
    recovery = messages.hold;
  }

  return { reply: recovery, blocked: true };
}

/* ----------------------------- ELEVENLABS CHAT ---------------------------- */

async function getElevenReply({
  userId,
  conversationLanguage,
  customerCountry,
  message,
  customerStatus,
  currentPhase,
  goal,
  objections,
  lastSummary,
  interestedInProgram,
  interestedInControl,
  purchasedProgram,
  hasControl,
  recentMessages,
  agentId,
  requestId,
  requestStartMs,
  pauseTurnGuard = "",
  intakeTurnGuard = "",
  checkoutTurnGuard = "",
}) {
  const fallbackReply = fallbackReplyForLanguage(conversationLanguage);
  const diag = (event, extra = {}) => {
    const now = Date.now();
    console.log(
      JSON.stringify(
        {
          diag: true,
          request_id: requestId,
          event,
          elapsed_ms: requestStartMs ? now - requestStartMs : null,
          timestamp_ms: now,
          ...extra,
        },
        null,
        2
      )
    );
  };

  return await new Promise((resolve) => {
    const wsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(
      agentId
    )}`;

    let finalReply = "";
    let firstPartLogged = false;
    let settled = false;
    let timeout = null;
    let ws = null;
    const wsStartMs = Date.now();

    diag("ELEVENLABS_WS_CONNECT_ATTEMPT", { ws_url: wsUrl });

    const settle = (reply) => {
      if (settled) return;
      settled = true;
      resolve(cleanReplyText(reply) || fallbackReply);
    };

    try {
      ws = new WebSocket(wsUrl);

      timeout = setTimeout(() => {
        diag("ELEVENLABS_WS_TIMEOUT", {
          ws_duration_ms: Date.now() - wsStartMs,
          partial_reply_length: finalReply.length,
        });
        console.error("ELEVENLABS TIMEOUT: geen reply binnen deadline");
        try {
          ws.close();
        } catch {}
        settle(finalReply || fallbackReply);
      }, ELEVEN_TIMEOUT_MS);

      ws.on("open", () => {
        diag("ELEVENLABS_WS_OPEN", {
          ws_open_after_ms: Date.now() - wsStartMs,
        });
        // Coaching mode is injected INTO the system prompt via the
        // {{coaching_banner}} dynamic variable (first line of the v42+ prompt).
        // A contextual update alone proved too weak against the sales flow in
        // the core prompt; a dynamic variable is substituted directly into the
        // system prompt text, the strongest possible position.
        const validatedCustomer = isCustomerStatusValidated(
          customerStatus,
          recentMessages
        );
        const coachingBanner = validatedCustomer
          ? [
              "!!! DEZE KLANT IS GEVALIDEERD KLANT — JE BENT 100% COACH !!!",
              "Geen verkoop, geen prijzen, geen programma's, geen upsells en geen checkout-links, tenzij de klant er expliciet zelf om vraagt (bijvoorbeeld naar een specifiek product of als reactie op een broadcast-bericht).",
              "Vraag NOOIT of de klant de website of de programma's al heeft bekeken.",
              'Zeg NOOIT "welkom terug", "goed dat je er weer bent", "goed om je weer te horen" of iets vergelijkbaars. Begin ALTIJD direct met je antwoord.',
              "Beantwoord ALLEEN het bericht van dit moment. Haal NIET zelf eerdere onderwerpen, doelen of gesprekken aan — de CRM-context is achtergrondkennis, geen gespreksstof.",
              "Stel GEEN vragen en houd het gesprek niet gaande vanuit jouw kant. Antwoord, help en rond af. Alleen een korte verduidelijkingsvraag als je de vraag van de klant anders echt niet kunt beantwoorden.",
              "De receptenpagina op nutritionworks.online noem je ALLEEN wanneer de klant zelf om recepten, maaltijd-ideeën of inspiratie vraagt. Nooit uit jezelf.",
            ].join("\n")
          : "";
        // Language lock, injected into the system prompt via the
        // {{language_lock}} dynamic variable (v43+ prompt). For Dutch the
        // template messages are used verbatim; for every other language Emma
        // writes native-quality text, never literal translations.
        const languageName =
          LANGUAGE_NAMES[conversationLanguage] || "Nederlands";
        const languageLock =
          conversationLanguage === "nl" || !conversationLanguage
            ? [
                "GESPREKSTAAL: Nederlands.",
                "Je schrijft ELK bericht uitsluitend in het Nederlands. De vaste voorbeeldberichten in deze prompt gebruik je letterlijk zoals ze er staan. Wissel nooit zelf van taal.",
              ].join("\n")
            : [
                `CONVERSATION LANGUAGE: ${languageName}.`,
                `You write EVERY message exclusively in ${languageName}, natural and native-speaker quality.`,
                "Never translate the Dutch template messages literally: they define structure, content, emojis and links only. Write them the way a native speaker would naturally phrase them.",
                "Never switch languages on your own; the server controls the conversation language.",
              ].join("\n");
        const countryLine =
          conversationLanguage === "nl" || !conversationLanguage
            ? `KLANTLAND: ${customerCountry || "UNKNOWN"} — gebruik ALTIJD de prijzen van dit land (tabel 4.1b). Bij UNKNOWN gebruik je de prijzen in ponden, zonder het land als UK te behandelen.`
            : `CUSTOMER COUNTRY: ${customerCountry || "UNKNOWN"} — ALWAYS use this country's prices (table 4.1b). For UNKNOWN use pound prices without treating the country as UK.`;
        const languageLockFull = `${languageLock}\n${countryLine}`;
        // Per-turn hard guards, injected into the system prompt via the
        // {{turn_guards}} dynamic variable. Flags inside the JSON context
        // proved too weak (Emma re-pasted the website block after a side
        // question); guards at the top of the system prompt stick.
        const guardWebsiteSent = hasPatternBeenSent(
          recentMessages,
          PLAIN_WEBSITE_LINK_PATTERN
        );
        const guardTestimonialsSent = hasPatternBeenSent(
          recentMessages,
          TESTIMONIALS_LINK_PATTERN
        );
        const guardProgrammaInfoSent = hasPatternBeenSent(
          recentMessages,
          PROGRAMMA_INFO_LINK_PATTERN
        );
        const guardCheckoutSent = hasCheckoutLinkBeenSent(recentMessages);
        const guardPriceMentioned = hasPriceBeenMentioned(recentMessages);
        const guardLines = [];
        if (cleanText(pauseTurnGuard)) {
          guardLines.push(cleanText(pauseTurnGuard));
        }
        if (cleanText(intakeTurnGuard)) {
          guardLines.push(cleanText(intakeTurnGuard));
        }
        if (cleanText(checkoutTurnGuard)) {
          guardLines.push(cleanText(checkoutTurnGuard));
        }
        if (guardWebsiteSent) {
          guardLines.push(
            'De website-link en het freebies-blok zijn AL gestuurd. Stuur ze NIET opnieuw uit jezelf — verwijs in woorden naar "de pagina die ik je stuurde". Alleen opnieuw sturen als de klant er expliciet om vraagt (bijvoorbeeld link kwijt), en dan alleen de kale link zonder freebies-blok. In coaching-modus mag de link alleen gedeeld worden als recepten-tool wanneer de klant zelf om recepten of inspiratie vraagt.'
          );
        }
        if (guardTestimonialsSent) {
          guardLines.push(
            "De testimonials-link is AL gedeeld. Stuur hem NIET opnieuw, ook niet bij twijfel of bezwaar (sectie 8.4 en 8.6) — dezelfde link twee keer sturen voelt automatisch. Verwijs in woorden naar de resultaten en vraag gerust of de klant ze al heeft kunnen bekijken. Twijfelt de klant vooral over WELK programma past: stuur dan de programma-uitleg pagina https://nutritionworks.online/#programma-info (mits die nog niet gedeeld is). Alleen als de klant expliciet om de testimonials-link vraagt, stuur je hem opnieuw."
          );
        }
        if (guardProgrammaInfoSent) {
          guardLines.push(
            "De programma-uitleg link is AL gedeeld. NIET opnieuw sturen, tenzij de klant er expliciet om vraagt."
          );
        }
        if (guardCheckoutSent) {
          guardLines.push(
            "Er is AL een checkout-link gestuurd. Geen nieuwe checkout-link, tenzij de klant er expliciet om vraagt of een andere keuze maakt."
          );
        }
        if (guardPriceMentioned) {
          guardLines.push(
            "De prijs is AL genoemd. Niet herhalen, tenzij de klant ernaar vraagt."
          );
        }
        if (hasReceivedTasteAnswer(recentMessages)) {
          guardLines.push(
            "De smaak is AL door de klant gegeven — vraag er NOOIT meer naar. Pak het antwoord uit de gespreksgeschiedenis."
          );
        }
        if (hasReceivedControlAnswer(recentMessages)) {
          guardLines.push(
            "De Control-vraag is AL beantwoord — vraag er NOOIT meer naar. Zijn product en smaak bekend: stuur NU direct de juiste checkout-link (sectie 5.3)."
          );
        } else if (
          hasAskedTaste(recentMessages) &&
          hasReceivedTasteAnswer(recentMessages) &&
          (customerCountry || "").toUpperCase() !== "PT"
        ) {
          guardLines.push(
            "De smaak is bekend, maar de Control-vraag is nog NIET beantwoord. Stuur GEEN checkout-link en neem Control niet aan. Vraag uitsluitend kort: 'Wil je Control erbij doen?' Pas na een duidelijk ja of nee mag de checkout-link worden gestuurd."
            "De smaak is bekend, maar de Control-vraag is nog NIET beantwoord. Stuur GEEN checkout-link en neem Control niet aan. Reageer zelf contextueel en vraag alleen op een natuurlijke manier of de klant Control erbij wil. Pas na een duidelijk ja of nee mag de checkout-link worden gestuurd."
          );
        }
        if ((customerCountry || "").toUpperCase() === "PT") {
          guardLines.push(
            "Deze klant zit in Portugal: Control is daar NIET beschikbaar. Sla de Control-upsell volledig over en verkoop nooit Control aan deze klant."
          );
        }
        // France runs its own checkout flow. This guard is keyed on
        // customer_country only (phone prefix), never on conversation_language:
        // a French-speaking Belgian stays on the Belgian flow.
        if ((customerCountry || "").toUpperCase() === "FR") {
          guardLines.push(
            [
              "Deze klant zit in FRANKRIJK. De Frankrijk-flow geldt:",
              "- Gebruik UITSLUITEND de checkout-links uit tabel 4.1c (die eindigen op -4x-fr). Gebruik NOOIT de universele links uit tabel 4.1, tenzij de klant zelf expliciet vraagt om alles in een keer te betalen.",
              "- Betalen gaat in 4 maandtermijnen met creditcard. Noem NOOIT Klarna en noem NOOIT 3 termijnen.",
              "- Noem prijzen alleen in het formaat 'EUR X x4'. Noem NOOIT een totaalbedrag en reken het totaal nooit voor de klant uit.",
              "- De 10% korting en de 2,50 euro termijnkosten zitten al in het bedrag. Noem ze niet uit jezelf.",
              "- Het is technisch een abonnement. Begin daar NOOIT zelf over. Vraagt de klant ernaar: eerlijk bevestigen, kort uitleggen dat het in het Juice Plus account met een paar klikken opgezegd wordt, en dat er anders na 4 maanden automatisch een nieuwe bestelling volgt.",
              "- SEPA nooit aanraden of uit jezelf noemen. Alleen kort feitelijk uitleggen als de klant er expliciet naar vraagt.",
              "- Alle programma's duren 4 maanden, ook Basic. Noem NOOIT 3 maanden en gebruik NOOIT het verhaal dat de capsules de vierde maand zijn.",
              "- Vraagt de klant of 90 porties genoeg is voor 4 maanden: antwoord ja, elke keer in je eigen woorden en nooit met een vaste zin.",
            ].join("\n")
          );
        } else {
          // Counterpart to the France guard above. The France 4-instalment
          // links and pricing live in the system prompt for every turn, so a
          // customer outside France asking for 4 monthly payments (which the
          // Dutch market genuinely used to offer) could otherwise pull Emma
          // toward a "-4x-fr" link that does not work in their country.
          guardLines.push(
            "Deze klant zit NIET in Frankrijk. Betalen in 4 maandtermijnen bestaat hier NIET en de checkout-links uit tabel 4.1c (die eindigen op -4x-fr) mag je NOOIT sturen. Vraagt de klant om 4 termijnen, bijvoorbeeld omdat dat vroeger in Nederland kon: zeg kort en eerlijk dat dat niet meer kan en bied Klarna in 3 termijnen aan. Beloof nooit dat je het nakijkt of regelt, en noem Frankrijk of andere markten niet."
          );
        }
        const turnGuards =
          guardLines.length > 0
            ? ["HARDE REGELS VOOR DEZE BEURT:", ...guardLines].join("\n")
            : "";

        const contextBlock = buildContextBlock({
          conversation_language: conversationLanguage,
          customer_country: customerCountry,
          customer_status: customerStatus,
          current_phase: currentPhase,
          goal,
          objections,
          last_summary: lastSummary,
          interested_in_program: interestedInProgram,
          interested_in_control: interestedInControl,
          purchased_program: purchasedProgram,
          has_control: hasControl,
          recent_messages: recentMessages,
          latest_user_message: message,
        });

        diag("ELEVENLABS_WS_CONTEXT_PREPARED", {
          context_block_size_bytes: contextBlock.length,
          message_length: typeof message === "string" ? message.length : 0,
          turn_guards_active: guardLines.length,
        });

        ws.send(
          JSON.stringify({
            type: "conversation_initiation_client_data",
            conversation_config_override: {
              conversation: { text_only: true },
            },
            dynamic_variables: {
              coaching_banner: coachingBanner,
              language_lock: languageLockFull,
              turn_guards: turnGuards,
            },
            user_id: userId,
          })
        );

        ws.send(
          JSON.stringify({
            type: "contextual_update",
            text: contextBlock,
          })
        );
        ws.send(
          JSON.stringify({
            type: "user_message",
            text: message,
          })
        );

        diag("ELEVENLABS_WS_MESSAGES_SENT");
      });

      ws.on("message", (raw) => {
        let data = null;

        try {
          data = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (data.type === "agent_chat_response_part") {
          const partType = data.text_response_part?.type;
          const partText = data.text_response_part?.text || "";

          if (partType === "start" || partType === "delta") {
            if (!firstPartLogged) {
              firstPartLogged = true;
              diag("ELEVENLABS_WS_FIRST_PART", {
                first_part_after_ms: Date.now() - wsStartMs,
                first_part_type: partType,
              });
            }
            finalReply += partText;
          }
        }

        if (data.type === "agent_response") {
          clearTimeout(timeout);

          diag("ELEVENLABS_WS_AGENT_RESPONSE", {
            ws_duration_ms: Date.now() - wsStartMs,
            reply_length: typeof data.agent_response_event?.agent_response === "string"
              ? data.agent_response_event.agent_response.length
              : 0,
            streamed_reply_length: finalReply.length,
          });

          try {
            ws.close();
          } catch {}

          const reply =
            cleanReplyText(data.agent_response_event?.agent_response) ||
            cleanReplyText(finalReply) ||
            fallbackReply;

          settle(reply);
        }
      });

      ws.on("error", (err) => {
        diag("ELEVENLABS_WS_ERROR", {
          ws_duration_ms: Date.now() - wsStartMs,
          error_message: err?.message || String(err),
        });
        console.error("ELEVENLABS WS ERROR:", err?.message || err);
        clearTimeout(timeout);
        settle(finalReply || fallbackReply);
      });

      ws.on("close", () => {
        diag("ELEVENLABS_WS_CLOSE", {
          ws_duration_ms: Date.now() - wsStartMs,
          settled_before_close: settled,
        });
        clearTimeout(timeout);
        if (!settled) {
          settle(finalReply || fallbackReply);
        }
      });
    } catch (error) {
      diag("ELEVENLABS_OUTER_ERROR", {
        error_message: error?.message || String(error),
      });
      console.error("ELEVENLABS OUTER ERROR:", error?.message || error);
      if (timeout) clearTimeout(timeout);
      settle(finalReply || fallbackReply);
    }
  });
}

/* -------------------------------- ROUTES -------------------------------- */

app.get("/health", (_req, res) => {
  return res.json({ ok: true });
});

app.post("/chat", async (req, res) => {
  // Diagnostic logging setup: every request gets a unique ID and a start timestamp
  // so we can reconstruct exactly what happened, in what order, and how long each
  // step took. All diagnostic log lines include diag:true so they can be filtered
  // in Render's log search.
  const requestId = randomUUID();
  const requestStartMs = Date.now();
  const requestBodySize = (() => {
    try {
      return JSON.stringify(req.body ?? {}).length;
    } catch {
      return -1;
    }
  })();

  const diag = (event, extra = {}) => {
    const now = Date.now();
    console.log(
      JSON.stringify(
        {
          diag: true,
          request_id: requestId,
          event,
          elapsed_ms: now - requestStartMs,
          timestamp_ms: now,
          ...extra,
        },
        null,
        2
      )
    );
  };

  diag("REQUEST_START", {
    request_body_size_bytes: requestBodySize,
    has_body: Boolean(req.body),
    remote_addr: req.ip,
  });

  const {
    user_id,
    message,
    customer_status = "",
    current_phase = "",
    goal = "",
    objections = "",
    last_summary = "",
    interested_in_program = "",
    interested_in_control = "",
    purchased_program = "",
    has_control = "",
    language = "",
    recent_messages = [],
  } = req.body ?? {};

  const agentId = cleanText(process.env.ELEVENLABS_AGENT_ID);

  const normalizedUserId = cleanText(user_id);
  const normalizedMessage = cleanText(message);
  const normalizedCustomerStatus = cleanText(customer_status);
  const normalizedCurrentPhase = cleanText(current_phase);
  const normalizedGoal = clamp(goal, MAX_GOAL_CHARS);
  const normalizedObjections = clamp(objections, MAX_OBJECTIONS_CHARS);
  const normalizedLastSummary = clamp(last_summary, MAX_SUMMARY_CHARS);
  const normalizedInterestedInProgram = clamp(interested_in_program, MAX_SHORT_FIELD_CHARS);
  const normalizedInterestedInControl = clamp(interested_in_control, MAX_SHORT_FIELD_CHARS);
  const normalizedPurchasedProgram = clamp(purchased_program, MAX_SHORT_FIELD_CHARS);
  const normalizedHasControl = clamp(has_control, MAX_SHORT_FIELD_CHARS);

  // Country and language are separate. Country comes only from the phone
  // number and controls market rules; language controls wording only.
  const customerCountry = detectCountryFromPhone(normalizedUserId) || "UNKNOWN";

  // Conversation language: the stored Airtable value wins; otherwise detect
  // deterministically. For +32, confident French/Dutch text outranks the Dutch
  // phone default so French-speaking Belgians remain in the Belgian market but
  // receive natural French. An unsupported detected language uses English.
  const storedLanguage = normalizeLanguage(language);
  let conversationLanguage = storedLanguage;
  let languageUpdate = "";
  if (!conversationLanguage) {
    const explicitRequest = detectExplicitLanguageRequest(normalizedMessage);
    const fromPhone = detectLanguageFromPhone(normalizedUserId);
    const fromText = detectLanguageFromText(normalizedMessage);
    const belgianTextLanguage = customerCountry === "BE"
      ? detectBelgianLanguageFromText(normalizedMessage)
      : "";
    conversationLanguage =
      explicitRequest ||
      belgianTextLanguage ||
      fromPhone ||
      (fromText === "other" ? "en" : fromText) ||
      "nl";
    languageUpdate = conversationLanguage;
  }

  if (
    storedLanguage &&
    customerCountry === "PT" &&
    ["en", "nl"].includes(storedLanguage)
  ) {
    const explicitRequest = detectExplicitLanguageRequest(normalizedMessage);
    const fromText = detectLanguageFromText(normalizedMessage);
    if (
      shouldMigrateLegacyPortugueseLanguage({
        storedLanguage,
        customerCountry,
        explicitRequest,
        textLanguage: fromText,
      })
    ) {
      conversationLanguage = "pt";
      languageUpdate = "pt";
    }
  }

  // Repair the old +32 Dutch default when an existing Belgian contact is
  // confidently writing French. This changes only conversation language;
  // customer_country remains BE, so no France checkout rule can leak in.
  if (storedLanguage === "nl" && customerCountry === "BE") {
    const explicitRequest = detectExplicitLanguageRequest(normalizedMessage);
    const belgianTextLanguage = detectBelgianLanguageFromText(normalizedMessage);
    if (!explicitRequest && belgianTextLanguage === "fr") {
      conversationLanguage = "fr";
      languageUpdate = "fr";
    }
  }

  diag("REQUEST_PARSED", {
    user_id: normalizedUserId,
    message_length: normalizedMessage.length,
    customer_status: normalizedCustomerStatus,
    current_phase: normalizedCurrentPhase,
    recent_messages_count: Array.isArray(recent_messages) ? recent_messages.length : 0,
  });

  const sendDiagResponse = (label, responseObject) => {
    let responseSize = -1;
    try {
      responseSize = JSON.stringify(responseObject).length;
    } catch {}
    diag("REQUEST_END", {
      exit_label: label,
      total_duration_ms: Date.now() - requestStartMs,
      response_size_bytes: responseSize,
      reply_length:
        typeof responseObject?.reply === "string"
          ? responseObject.reply.length
          : 0,
    });
    return res.json(responseObject);
  };

  console.log("CHAT HIT");
  console.log(
    JSON.stringify(
      {
        user_id: normalizedUserId,
        message_preview: clamp(normalizedMessage, 120),
        customer_status: normalizedCustomerStatus,
        current_phase: normalizedCurrentPhase,
        has_goal: Boolean(normalizedGoal),
        has_objections: Boolean(normalizedObjections),
        has_last_summary: Boolean(normalizedLastSummary),
      },
      null,
      2
    )
  );

  if (!normalizedUserId) {
    console.error("REQUEST ERROR: user_id ontbreekt");
    return sendDiagResponse("fallback_reply", buildResponse({ send_reply: true, reply: fallbackReplyForLanguage(conversationLanguage), language: conversationLanguage }));
  }

  if (!normalizedMessage) {
    console.error("REQUEST ERROR: message ontbreekt");
    return sendDiagResponse("fallback_reply", buildResponse({ send_reply: true, reply: fallbackReplyForLanguage(conversationLanguage), language: conversationLanguage }));
  }

  const normalizedRecentMessages = sanitizeAndPrepareRecentMessages(
    recent_messages,
    normalizedMessage
  );

  // Language switching for known customers: after the two narrow legacy
  // repairs above (PT and French-speaking BE), ONLY an explicit request
  // switches the language and re-locks it. Writing style alone never changes
  // an otherwise valid stored language.
  if (storedLanguage) {
    const explicitRequest = detectExplicitLanguageRequest(normalizedMessage);
    if (explicitRequest && explicitRequest !== conversationLanguage) {
      conversationLanguage = explicitRequest;
      languageUpdate = explicitRequest;
    }
  }

  console.log(
    JSON.stringify(
      {
        event: "PROCESSING_MESSAGE",
        user_id: normalizedUserId,
        final_message_preview: clamp(normalizedMessage, 300),
        recent_messages_count: normalizedRecentMessages.length,
        has_whatsapp_group_link: hasWhatsappGroupLinkBeenSent(normalizedRecentMessages),
        last_roles: normalizedRecentMessages.slice(-5).map((m) => m.role),
      },
      null,
      2
    )
  );

  // NEW USER FAST PATH: when context is fully empty (no customer_status,
  // no history, no summary) we send the hardcoded welcome reply directly.
  // Emma is intentionally NOT invoked here — that prevents her from
  // misinterpreting opt-in triggers like "coach-Jelle" as a customer telling
  // her about a previous coach. Source attribution (Airtable Bron) is handled
  // entirely by Make/Airtable downstream from the original message body.
  if (
    isNewUser({
      recentMessages: normalizedRecentMessages,
      lastSummary: normalizedLastSummary,
    })
  ) {
    diag("NEW_USER_WELCOME", {
      first_message_preview: clamp(normalizedMessage, 120),
      customer_status_received: normalizedCustomerStatus,
      language: conversationLanguage,
    });
    return sendDiagResponse(
      "new_user_welcome",
      buildResponse({
        send_reply: true,
        reply: welcomeMessageFor(conversationLanguage, customerCountry),
        language: conversationLanguage,
        language_update: languageUpdate,
      })
    );
  }

  // Pause/intake and checkout state are classified in parallel. Both
  // classifiers are semantic and multilingual; neither relies on a
  // language-specific word list to decide the state of the conversation.
  // Only the exceptional pause and technical checkout states are classified
  // in parallel. Ordinary intake, doubt, advice and conversation flow remain
  // with Emma. Neither classifier relies on a language-specific word list.
  const [pauseClassification, checkoutClassification] = await Promise.all([
    classifyConversationPause({
      message: normalizedMessage,
      recentMessages: normalizedRecentMessages,
      currentGoal: normalizedGoal,
      currentLastSummary: normalizedLastSummary,
      currentPhase: normalizedCurrentPhase,
      customerStatus: normalizedCustomerStatus,
      conversationLanguage,
      requestId,
      requestStartMs,
    }),
    classifyCheckoutState({
      message: normalizedMessage,
      recentMessages: shouldClassifyCheckoutState(
        normalizedMessage,
        normalizedRecentMessages
      )
        ? normalizedRecentMessages
        : [],
      customerCountry,
      requestId,
      requestStartMs,
    }),
  ]);
  const pauseDecision = decidePauseAction(
    pauseClassification,
    normalizedRecentMessages,
    requestStartMs
  );

  diag("PAUSE_CONTEXT_EVALUATED", {
    ...pauseClassification,
    ...pauseDecision,
    minimum_resume_ms: Number.isFinite(PAUSE_MIN_RESUME_MS)
      ? PAUSE_MIN_RESUME_MS
      : 30 * 60 * 1000,
  });

  if (pauseDecision.action === "heart_only") {
    diag("PAUSE_CLOSING_HEART_SENT", {
      elapsed_since_previous_message_ms: pauseDecision.elapsed_ms,
      timestamps_available: pauseDecision.timestamps_available,
    });
    return sendDiagResponse(
      "pause_closing_heart",
      buildResponse({
        send_reply: true,
        reply: "💚",
        language: conversationLanguage,
        language_update: languageUpdate,
      })
    );
  }

  const alreadyValidatedForCheckout = isCustomerStatusValidated(
    normalizedCustomerStatus,
    normalizedRecentMessages
  );
  const classifiedIntakeDecision = decideIntakeAction({
    classification: pauseClassification,
    recentMessages: normalizedRecentMessages,
    validatedCustomer: alreadyValidatedForCheckout,
  });
  const intakeDecision =
    pauseDecision.action === "guarded_reply" &&
    classifiedIntakeDecision.testimonials_allowed === true
      ? { action: "hold_intake", testimonials_allowed: false }
      : classifiedIntakeDecision;
  const intakeTurnGuard =
    pauseDecision.action === "guarded_reply"
      ? ""
      : buildStructuralIntakeTurnGuard({
          recentMessages: normalizedRecentMessages,
          validatedCustomer: alreadyValidatedForCheckout,
        });

  diag("INTAKE_CONTEXT_EVALUATED", {
    intake_context_active: pauseClassification.intake_context_active,
    goal_context_clear: pauseClassification.goal_context_clear,
    challenge_context_clear: pauseClassification.challenge_context_clear,
    checklist_sent: pauseClassification.checklist_sent,
    checklist_detected_server_side: hasStep2ChecklistBeenSent(
      normalizedRecentMessages
    ),
    intake_follow_up_questions_asked:
      countNaturalIntakeFollowUps(normalizedRecentMessages),
    post_checklist_clarifications_asked:
      countPostChecklistClarifications(normalizedRecentMessages),
    checklist_response_type: pauseClassification.checklist_response_type,
    direct_testimonials_request:
      pauseClassification.direct_testimonials_request,
    intake_confidence: pauseClassification.intake_confidence,
    intake_classifier_trusted: ["high", "medium"].includes(
      cleanText(pauseClassification.intake_confidence)
    ),
    intake_action: intakeDecision.action,
    primary_agent_contextual_fallback:
      intakeDecision.action === "contextual_after_checklist",
    testimonials_allowed: intakeDecision.testimonials_allowed,
    structural_guard_active: Boolean(intakeTurnGuard),
    meaning_decided_by: "elevenlabs_agent",
  });

  const checkoutDecision = decideCheckoutAction({
    classification: checkoutClassification,
    recentMessages: normalizedRecentMessages,
    customerCountry,
    validatedCustomer: alreadyValidatedForCheckout,
  });

  diag("CHECKOUT_CONTEXT_EVALUATED", {
    ...checkoutClassification,
    action: checkoutDecision.action,
    checkout_program_resolved: checkoutDecision.program,
    checkout_taste_resolved: checkoutDecision.taste,
    checkout_control_resolved: checkoutDecision.control,
    checkout_payment_mode_resolved: checkoutDecision.payment_mode,
    has_previous_checkout_link: Boolean(checkoutDecision.previous_checkout_link),
    has_new_checkout_link: Boolean(checkoutDecision.checkout_link),
  });

  if (checkoutDecision.action !== "normal") {
    const checkoutReply = buildCheckoutActionReply({
      decision: checkoutDecision,
      language: conversationLanguage,
      customerCountry,
    });
    if (checkoutReply) {
      return sendDiagResponse(
        `checkout_${checkoutDecision.action}`,
        buildResponse({
          send_reply: true,
          reply: checkoutReply,
  const checkoutTurnGuard =
    pauseDecision.action === "guarded_reply"
      ? ""
      : buildCheckoutTurnGuard({
          decision: checkoutDecision,
          classification: checkoutClassification,
          language: conversationLanguage,
          language_update: languageUpdate,
        })
      );
    }
  }
          customerCountry,
        });

  const pauseTurnGuard =
    pauseDecision.action === "guarded_reply"
      ? [
          "CONTEXTUELE PAUZE ACTIEF: de klant had aangegeven het gesprek later voort te zetten en de minimale pauze van 30 minuten is nog niet verstreken of de tijd is niet betrouwbaar beschikbaar.",
          "Het nieuwste bericht bevat wel echte inhoud. Beantwoord uitsluitend die inhoud kort en behulpzaam.",
          "Beschouw dit NIET als toestemming om de salesflow opnieuw te starten of verder te duwen. Stel geen nieuwe verkoopvraag, hervat geen oude vervolgvraag en introduceer geen volgende stap uit jezelf.",
          "Noem de pauze, tijd of terugkomst nooit tegen de klant.",
        ].join("\n")
      : "";
  const intakeTurnGuard = buildIntakeTurnGuard({
    decision: intakeDecision,
    classification: pauseClassification,
  });

  if (!agentId) {
    console.error("CONFIG ERROR: ELEVENLABS_AGENT_ID ontbreekt");
    return sendDiagResponse("fallback_reply", buildResponse({ send_reply: true, reply: fallbackReplyForLanguage(conversationLanguage), language: conversationLanguage }));
  }

  try {
    const alreadyValidated = alreadyValidatedForCheckout;

    diag("ELEVENLABS_DISPATCH", {
      already_validated: alreadyValidated,
      customer_status_passed: alreadyValidated ? "customer" : normalizedCustomerStatus,
      current_phase_passed: alreadyValidated ? "coaching" : normalizedCurrentPhase,
      recent_messages_count: normalizedRecentMessages.length,
    });

    // Start both calls in parallel. We only block on ElevenLabs (the customer-facing reply);
    // OpenAI extraction runs alongside and is awaited briefly later with a grace timeout
    // so it cannot push the total response time past ManyChat's webhook timeout.
    const replyPromise = getElevenReply({
      userId: normalizedUserId,
      conversationLanguage,
      customerCountry,
      message: normalizedMessage,
      customerStatus: alreadyValidated
        ? "customer"
        : normalizedCustomerStatus,
      currentPhase: alreadyValidated
        ? "coaching"
        : normalizedCurrentPhase,
      goal: normalizedGoal,
      objections: normalizedObjections,
      lastSummary: normalizedLastSummary,
      interestedInProgram: normalizedInterestedInProgram,
      interestedInControl: normalizedInterestedInControl,
      purchasedProgram: normalizedPurchasedProgram,
      hasControl: normalizedHasControl,
      recentMessages: normalizedRecentMessages,
      agentId,
      requestId,
      requestStartMs,
      pauseTurnGuard,
      intakeTurnGuard,
      checkoutTurnGuard,
    });

    const extractionPromise = getStructuredUpdates({
      message: normalizedMessage,
      customerStatus: alreadyValidated
        ? "customer"
        : normalizedCustomerStatus,
      currentPhase: alreadyValidated
        ? "coaching"
        : normalizedCurrentPhase,
      currentGoal: normalizedGoal,
      currentObjections: normalizedObjections,
      currentLastSummary: normalizedLastSummary,
      currentInterestedInProgram: normalizedInterestedInProgram,
      currentInterestedInControl: normalizedInterestedInControl,
      currentPurchasedProgram: normalizedPurchasedProgram,
      currentHasControl: normalizedHasControl,
      recentMessages: normalizedRecentMessages,
      requestId,
      requestStartMs,
    });

    const replyResult = await replyPromise.then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason })
    );

    diag("ELEVENLABS_DONE", {
      status: replyResult.status,
      reply_length:
        replyResult.status === "fulfilled" && typeof replyResult.value === "string"
          ? replyResult.value.length
          : 0,
      reject_reason:
        replyResult.status === "rejected"
          ? String(replyResult.reason?.message || replyResult.reason)
          : null,
    });

    let reply =
      replyResult.status === "fulfilled"
        ? cleanReplyText(replyResult.value) || fallbackReplyForLanguage(conversationLanguage)
        : fallbackReplyForLanguage(conversationLanguage);

    if (replyResult.status === "rejected") {
      console.error("ELEVENLABS PROMISE ERROR:", replyResult.reason);
    }

    console.log(
      JSON.stringify(
        {
          event: "ELEVENLABS_RAW_REPLY",
          user_id: normalizedUserId,
          raw_reply_preview: clamp(
            replyResult.status === "fulfilled" ? replyResult.value : "",
            400
          ),
        },
        null,
        2
      )
    );

    reply = stripForbiddenReplyPhrases(cleanReplyText(reply));

    // Hard backstop for the early intake. Prompt instructions and per-turn
    // guards guide Emma, but the server still refuses a testimonials link when
    // the semantic intake gate has not confirmed all required conditions.
    const testimonialGateResult = enforceTestimonialsGate({
      reply,
      intakeDecision,
      intakeClassification: pauseClassification,
      language: conversationLanguage,
    });
    reply = testimonialGateResult.reply;
    if (testimonialGateResult.blocked) {
      diag("PREMATURE_TESTIMONIALS_BLOCKED", {
        intake_action: intakeDecision.action,
        intake_confidence: pauseClassification.intake_confidence,
      });
    }
    // Emma owns semantic conversation flow. The server no longer replaces her
    // intake response or an open checkout choice with a canned customer-facing
    // sentence. Structural milestones and verified checkout facts were already
    // supplied in turn_guards; the final controls below only protect technical
    // invariants such as one-time blocks and valid links.

    // Deterministic checkout backstop: when Emma asked for both taste and
    // Control and the customer replies with only a taste, Control is still an
    // open choice. Never infer Control from earlier generic interest or a prior
    // "ja", and never send a combo checkout-link until the customer explicitly
    // answers the Control question.
    const tasteKnownForCheckout = hasReceivedTasteAnswer([
      ...normalizedRecentMessages,
      { role: "user", message_text: normalizedMessage },
    ]);
    const controlAnsweredForCheckout = hasReceivedControlAnswer([
      ...normalizedRecentMessages,
      { role: "user", message_text: normalizedMessage },
    ]);
    const tasteWasAskedForCheckout = hasAskedTaste(normalizedRecentMessages);
    const checkoutAlreadySentForCheckout = hasCheckoutLinkBeenSent(
      normalizedRecentMessages
    );

    if (
      !alreadyValidated &&
      (customerCountry || "").toUpperCase() !== "PT" &&
      tasteWasAskedForCheckout &&
      tasteKnownForCheckout &&
      !controlAnsweredForCheckout &&
      !checkoutAlreadySentForCheckout &&
      isTasteOnlyCheckoutAnswer(normalizedMessage)
    ) {
      reply = controlFollowUpForLanguage(
        conversationLanguage,
        normalizedMessage
      );
    }

    // Backstop: the Stap 4 website/freebies block is sent once. If it was
    // already sent and the customer did not explicitly ask for it (or for
    // recipes/inspiration), a repeated block is removed from the reply.
    if (
      hasPatternBeenSent(normalizedRecentMessages, PLAIN_WEBSITE_LINK_PATTERN) &&
      !/\b(website|site|link|lien|enlace|liga[cç][aã]o|pagina|p[aá]gina|page|seite|sito|strona|recept|recepten|recipe|recipes|recette|recettes|rezept|rezepte|ricetta|ricette|receta|recetas|receita|receitas|przepis|przepisy|inspiratie|inspiration|inspiraci[oó]n|inspira[cç][aã]o|kwijt|lost|perdu|verloren|perso|perdido|nogmaals|opnieuw|again|encore|erneut|nuovo|otra vez|novamente|ponownie|stuur|send|envoie|schick|invia|env[ií]a|envia|wy[sś]lij)\b/i.test(
        normalizedMessage
      )
    ) {
      reply = stripRepeatedWebsiteBlock(reply, conversationLanguage);
    }

    const checkoutLinkValidation = enforceCheckoutLinksInReply({
      reply,
      classification: checkoutClassification,
      recentMessages: normalizedRecentMessages,
      customerCountry,
      language: conversationLanguage,
      currentMessage: normalizedMessage,
    });
    reply = checkoutLinkValidation.reply;
    if (checkoutLinkValidation.changed) {
      diag("CHECKOUT_LINK_FINAL_CONTROL", {
        reason: checkoutLinkValidation.reason,
      });
    }

    // Give OpenAI a short grace period to finish after ElevenLabs is done.
    // If it hasn't returned by then, give up and send empty updates so the
    // response goes back to Make fast. The OpenAI call keeps running in
    // the background; its result for this turn is simply discarded.
    const POST_REPLY_EXTRACTION_GRACE_MS = Number(
      process.env.POST_REPLY_EXTRACTION_GRACE_MS || 3000
    );

    const extractionRaceStartMs = Date.now();
    const extractionResult = await Promise.race([
      extractionPromise.then(
        (value) => ({ status: "fulfilled", value }),
        (reason) => ({ status: "rejected", reason })
      ),
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              status: "rejected",
              reason: "post_reply_grace_timeout",
            }),
          POST_REPLY_EXTRACTION_GRACE_MS
        )
      ),
    ]);

    diag("OPENAI_DONE", {
      status: extractionResult.status,
      reason: extractionResult.status === "rejected"
        ? String(extractionResult.reason?.message || extractionResult.reason)
        : null,
      grace_wait_ms: Date.now() - extractionRaceStartMs,
      grace_limit_ms: POST_REPLY_EXTRACTION_GRACE_MS,
    });

    const extraction =
      extractionResult.status === "fulfilled"
        ? extractionResult.value
        : {
            goal_update: "",
            objections_update: "",
            last_summary_update: "",
            current_phase_update: "",
            interested_in_program_update: "",
            interested_in_control_update: "",
            purchased_program_update: "",
            has_control_update: "",
          };

    if (extractionResult.status === "rejected") {
      console.error(
        "OPENAI EXTRACTION SKIPPED OR FAILED:",
        extractionResult.reason
      );
    }

    // Self-healing: if the conversation history shows this person is already a
    // validated customer (WhatsApp group link was sent earlier) but Airtable
    // still says "lead", push customer_status back to "customer" so the record
    // catches up. Same for current_phase moving to "coaching".
    const whatsappLinkInCurrentReply = /chat\.whatsapp\.com/i.test(
      cleanText(reply)
    );
    const whatsappLinkSentNowOrEarlier =
      whatsappLinkInCurrentReply ||
      hasWhatsappGroupLinkBeenSent(normalizedRecentMessages);

    // A user is considered a validated customer as soon as they have shared
    // a valid order number, regardless of whether Emma has sent the WhatsApp
    // group link yet. This is more robust than tying customer_status to
    // Emma's reply behavior, because Emma might forget to send the link or
    // phrase her confirmation differently in upsell scenarios. The presence
    // of a valid JP-pattern order number in the user's messages is the
    // single source of truth: order number = customer = coaching mode.
    const userHasOrderNumber = userMessagesContainOrderNumber(
      normalizedRecentMessages,
      normalizedMessage
    );

    const validatedNow =
      alreadyValidated || whatsappLinkInCurrentReply || userHasOrderNumber;
    // Coaching mode: deterministically remove trailing questions (the prompt
    // rule alone proved insufficient in production).
    if (validatedNow) {
      reply = stripTrailingCoachingQuestions(reply);
    }

    const selfHealCustomerStatus =
      validatedNow &&
      normalizedCustomerStatus.toLowerCase() !== "customer"
        ? "customer"
        : "";

    const selfHealCurrentPhase =
      validatedNow &&
      normalizedCurrentPhase.toLowerCase() !== "coaching"
        ? "coaching"
        : "";

    // Server-side derivation of product fields (deterministic, replaces the
    // extractor output for purchased_program, has_control, interested_in_program
    // and interested_in_control).
    // Purchase facts remain deterministic. Interest and doubt are semantic,
    // so those fields come from the contextual extractor rather than a word
    // matcher that would turn "Beauty or Deluxe" into a false single choice.
    const derivedPurchase = derivePurchaseFields({
      recentMessages: normalizedRecentMessages,
      currentUserMessage: normalizedMessage,
      currentReply: reply,
      whatsappGroupLinkSentNowOrEarlier: whatsappLinkSentNowOrEarlier,
    });

    // customer_status is purely server-side (order control + self-healing).
    // current_phase can come from the extractor, but self-healing overrides it
    // to "coaching" once the customer is validated.
    const finalCustomerStatusUpdate = selfHealCustomerStatus;
    const finalCurrentPhaseUpdate =
      selfHealCurrentPhase || extraction.current_phase_update;

    // Product fields: code-side derivation always wins over the extractor.
    // We only write a non-empty value (so we never overwrite a previously
    // correct Airtable value with an empty string).
    const finalInterestedInProgramUpdate = derivedPurchase.interested_in_program;
    const finalInterestedInControlUpdate = derivedPurchase.interested_in_control;
    // We only write a non-empty value, so uncertainty never overwrites an
    // earlier correct Airtable choice.
    const finalInterestedInProgramUpdate =
      extraction.interested_in_program_update;
    const finalInterestedInControlUpdate =
      extraction.interested_in_control_update;
    const finalPurchasedProgramUpdate = derivedPurchase.purchased_program;
    const finalHasControlUpdate = derivedPurchase.has_control;

    console.log(
      JSON.stringify(
        {
          event: "FINAL_REPLY_SENT",
          user_id: normalizedUserId,
          final_reply_preview: clamp(reply, 400),
          goal_update_preview: clamp(extraction.goal_update, 200),
          objections_update_preview: clamp(extraction.objections_update, 200),
          last_summary_update_preview: clamp(extraction.last_summary_update, 200),
          customer_status_update_preview: finalCustomerStatusUpdate,
          current_phase_update_preview: finalCurrentPhaseUpdate,
          interested_in_program_update_preview: finalInterestedInProgramUpdate,
          interested_in_control_update_preview: finalInterestedInControlUpdate,
          purchased_program_update_preview: finalPurchasedProgramUpdate,
          has_control_update_preview: finalHasControlUpdate,
          language: conversationLanguage,
          language_update_preview: languageUpdate,
          derived_purchase_validated: derivedPurchase.validated,
          extractor_purchased_program_raw: extraction.purchased_program_update,
          extractor_has_control_raw: extraction.has_control_update,
          extractor_interested_in_program_raw: extraction.interested_in_program_update,
          extractor_interested_in_control_raw: extraction.interested_in_control_update,
        },
        null,
        2
      )
    );

    return sendDiagResponse(
      "normal_flow",
      buildResponse({
        send_reply: true,
        reply,
        goal_update: extraction.goal_update,
        objections_update: extraction.objections_update,
        last_summary_update: extraction.last_summary_update,
        customer_status_update: finalCustomerStatusUpdate,
        current_phase_update: finalCurrentPhaseUpdate,
        interested_in_program_update: finalInterestedInProgramUpdate,
        interested_in_control_update: finalInterestedInControlUpdate,
        purchased_program_update: finalPurchasedProgramUpdate,
        has_control_update: finalHasControlUpdate,
        language: conversationLanguage,
        language_update: languageUpdate,
      })
    );
  } catch (error) {
    diag("SERVER_ERROR", {
      error_message: error?.message || String(error),
    });
    console.error("SERVER ERROR:", error?.message || error);
    return sendDiagResponse("server_error_fallback", buildResponse({ send_reply: true, reply: fallbackReplyForLanguage(conversationLanguage), language: conversationLanguage }));
  }
});

app.listen(PORT, () => {
  console.log(`Server draait op poort ${PORT}`);
});
