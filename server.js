import express from "express";
import WebSocket from "ws";
import OpenAI from "openai";
import dotenv from "dotenv";
import { randomUUID } from "crypto";
import { franc } from "franc-min";

dotenv.config();

const app = express();
const SERVER_BUILD_ID = "emma-v51-candidate-2026-08-27-04";
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

const MAX_CONTEXT_MESSAGES = Number(process.env.MAX_CONTEXT_MESSAGES || 30);
const EXTRACTOR_CONTEXT_MESSAGES = Number(process.env.EXTRACTOR_CONTEXT_MESSAGES || 20);
const LANGUAGE_TEXT_MIN_CHARS = Number(process.env.LANGUAGE_TEXT_MIN_CHARS || 15);
const MAX_MESSAGE_CHARS = Number(process.env.MAX_MESSAGE_CHARS || 500);
const MAX_SUMMARY_CHARS = Number(process.env.MAX_SUMMARY_CHARS || 900);
const MAX_GOAL_CHARS = Number(process.env.MAX_GOAL_CHARS || 300);
const MAX_OBJECTIONS_CHARS = Number(process.env.MAX_OBJECTIONS_CHARS || 400);
const MAX_SHORT_FIELD_CHARS = Number(process.env.MAX_SHORT_FIELD_CHARS || 30);

const NO_REPLY = "__NO_REPLY__";

const FALLBACK_REPLY =
  "Er ging iets mis met mijn antwoord, kun je je bericht nog een keer sturen";

const FALLBACK_REPLIES = {
  nl: FALLBACK_REPLY,
  en: "Something went wrong with my reply. Could you send your message again?",
  fr: "Un problème est survenu avec ma réponse. Peux-tu renvoyer ton message ?",
  de: "Bei meiner Antwort ist etwas schiefgelaufen. Kannst du deine Nachricht noch einmal senden?",
  it: "Si è verificato un problema con la mia risposta. Puoi inviare di nuovo il tuo messaggio?",
  es: "Ha ocurrido un problema con mi respuesta. ¿Puedes enviar tu mensaje de nuevo?",
  pt: "Ocorreu um problema com a minha resposta. Podes enviar novamente a tua mensagem?",
  pl: "Wystąpił problem z moją odpowiedzią. Czy możesz wysłać wiadomość jeszcze raz?",
};

function fallbackReplyForLanguage(language) {
  return FALLBACK_REPLIES[cleanText(language).toLowerCase()] || FALLBACK_REPLY;
}

const WELCOME_MESSAGE =
  "Hallo, ik ben Emma 😊\n\n" +
  "Ik help dagelijks mensen om hun gezondheidsdoelen te bereiken en ik denk graag met je mee 🤗\n\n" +
  "We hebben al tienduizenden mensen geholpen en ik denk dat ik jou ook goed kan helpen 💚\n\n" +
  "Vertel eens, waar zou jij het allerliefst verandering in willen zien? 💚\n\n" +
  "Je mag zo uitgebreid of juist zo kort antwoorden als je wilt. Alles is goed 🤗\n\n" +
  "Vertel bijvoorbeeld iets over je doel, waar je tegenaan loopt of wat je al geprobeerd hebt.";

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
  // Frankrijk heeft een eigen openingsbericht, geschreven op conversie.
  // Opzet: sociale bewijskracht eerst, dan een lage-drempelvraag naar doel EN
  // grootste obstakel (samen precies de Stap 2-gate uit de prompt), met het
  // kilo-aantal expliciet als optioneel. "Gratis" staat er bewust in: het haalt
  // de belangrijkste onuitgesproken drempel weg voordat die ontstaat.
  fr:
    "Coucou ! \u{1F60A} Super que tu aies r\u00e9pondu !\n\n" +
    "Tu souhaites perdre du poids ? Je serais ravie de t\u2019aider \u00e0 y arriver.\n\n" +
    "J\u2019ai d\u00e9j\u00e0 accompagn\u00e9 des milliers de femmes et d\u2019hommes avec de tr\u00e8s beaux r\u00e9sultats, et surtout sans le fameux effet yo-yo tant redout\u00e9 !\n\n" +
    "La plupart avaient pourtant d\u00e9j\u00e0 essay\u00e9 plein de choses, sans obtenir les r\u00e9sultats qu\u2019ils esp\u00e9raient.\n\n" +
    "Est-ce que je peux te demander ce que tu as d\u00e9j\u00e0 essay\u00e9 ?",
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
    "Ol\u00e1, eu sou a Emma \u{1F60A}\n\n" +
    "Todos os dias ajudo pessoas a alcan\u00e7ar os seus objetivos de sa\u00fade e terei todo o gosto em pensar contigo no que poder\u00e1 resultar melhor \u{1F917}\n\n" +
    "J\u00e1 ajud\u00e1mos dezenas de milhares de pessoas e acredito que tamb\u00e9m te posso ajudar \u{1F49A}\n\n" +
    "Conta-me: o que gostarias mais de mudar? \u{1F49A}\n\n" +
    "Podes responder com o detalhe que quiseres ou de forma muito breve. Est\u00e1 tudo bem \u{1F917}\n\n" +
    "Podes, por exemplo, falar-me do teu objetivo, do que te est\u00e1 a dificultar ou do que j\u00e1 tentaste.",
  pl:
    "Cze\u015b\u0107, jestem Emma \u{1F60A}\n\n" +
    "Ka\u017cdego dnia pomagam ludziom osi\u0105ga\u0107 cele zdrowotne i ch\u0119tnie zastanowi\u0119 si\u0119 razem z Tob\u0105, co b\u0119dzie najlepsze \u{1F917}\n\n" +
    "Pomogli\u015bmy ju\u017c dziesi\u0105tkom tysi\u0119cy os\u00f3b i my\u015bl\u0119, \u017ce Tobie te\u017c mog\u0119 dobrze pom\u00f3c \u{1F49A}\n\n" +
    "Powiedz, co najbardziej chcia\u0142aby\u015b zmieni\u0107? \u{1F49A}\n\n" +
    "Mo\u017cesz odpowiedzie\u0107 bardzo szczeg\u00f3\u0142owo albo kr\u00f3tko. Ka\u017cda odpowied\u017a jest w porz\u0105dku \u{1F917}\n\n" +
    "Mo\u017cesz na przyk\u0142ad opisa\u0107 sw\u00f3j cel, to, co Ci\u0119 teraz blokuje, albo czego ju\u017c pr\u00f3bowa\u0142a\u015b.",
};

// France keeps its own conversion opening. French-speaking customers outside
// France receive the normal French version; country and language stay separate.
const FRANCE_WELCOME_MESSAGES = {
  nl:
    "Hoi! \u{1F60A} Super dat je hebt gereageerd!\n\n" +
    "Wil je graag afvallen? Ik help je daar heel graag bij.\n\n" +
    "Ik heb al duizenden vrouwen en mannen begeleid met prachtige resultaten, vooral zonder het gevreesde jojo-effect.\n\n" +
    "De meesten hadden al van alles geprobeerd zonder het resultaat waarop ze hoopten.\n\n" +
    "Mag ik vragen wat je al hebt geprobeerd?",
  en:
    "Hi! \u{1F60A} It’s great that you replied!\n\n" +
    "Would you like to lose weight? I’d be very happy to help you with that.\n\n" +
    "I’ve already guided thousands of women and men with wonderful results, especially without the dreaded yo-yo effect.\n\n" +
    "Most of them had already tried many things without getting the result they hoped for.\n\n" +
    "May I ask what you have already tried?",
  fr: WELCOME_MESSAGES.fr,
  de:
    "Hallo! \u{1F60A} Schön, dass du geantwortet hast!\n\n" +
    "Möchtest du abnehmen? Ich helfe dir sehr gern dabei.\n\n" +
    "Ich habe bereits Tausende Frauen und Männer mit großartigen Ergebnissen begleitet, vor allem ohne den gefürchteten Jo-Jo-Effekt.\n\n" +
    "Die meisten hatten schon vieles ausprobiert, ohne das erhoffte Ergebnis zu erzielen.\n\n" +
    "Darf ich fragen, was du bereits ausprobiert hast?",
  it:
    "Ciao! \u{1F60A} Che bello che hai risposto!\n\n" +
    "Ti piacerebbe perdere peso? Sarò molto felice di aiutarti.\n\n" +
    "Ho già seguito migliaia di donne e uomini con splendidi risultati, soprattutto senza il temuto effetto yo-yo.\n\n" +
    "La maggior parte aveva già provato tante cose senza ottenere il risultato sperato.\n\n" +
    "Posso chiederti che cosa hai già provato?",
  es:
    "¡Hola! \u{1F60A} ¡Qué bien que hayas respondido!\n\n" +
    "¿Te gustaría perder peso? Estaré encantada de ayudarte.\n\n" +
    "Ya he acompañado a miles de mujeres y hombres con resultados magníficos, sobre todo sin el temido efecto rebote.\n\n" +
    "La mayoría ya había probado muchas cosas sin conseguir el resultado que esperaba.\n\n" +
    "¿Puedo preguntarte qué has probado hasta ahora?",
  pt:
    "Olá! \u{1F60A} Que bom teres respondido!\n\n" +
    "Gostarias de perder peso? Terei todo o gosto em ajudar-te.\n\n" +
    "Já acompanhei milhares de mulheres e homens com excelentes resultados, sobretudo sem o tão receado efeito ioiô.\n\n" +
    "A maioria já tinha tentado muitas coisas sem alcançar o resultado esperado.\n\n" +
    "Posso perguntar-te o que já tentaste?",
  pl:
    "Cześć! \u{1F60A} Świetnie, że udało Ci się odpowiedzieć!\n\n" +
    "Chcesz schudnąć? Z przyjemnością Ci w tym pomogę.\n\n" +
    "Pomogłam już tysiącom kobiet i mężczyzn osiągnąć piękne rezultaty, przede wszystkim bez obawianego efektu jo-jo.\n\n" +
    "Większość z nich próbowała już wielu rzeczy bez oczekiwanego rezultatu.\n\n" +
    "Mogę zapytać, czego już próbowałaś lub próbowałeś?",
};
WELCOME_MESSAGES.fr =
  "Bonjour, je suis Emma \u{1F60A}\n\n" +
  "J'aide chaque jour des personnes à atteindre leurs objectifs de santé et je serai ravie de réfléchir avec toi à ce qui peut te convenir \u{1F917}\n\n" +
  "Nous avons déjà aidé des dizaines de milliers de personnes et je pense pouvoir aussi t'aider \u{1F49A}\n\n" +
  "Dis-moi, qu'aimerais-tu le plus voir changer ? \u{1F49A}\n\n" +
  "Tu peux répondre de façon très détaillée ou très brièvement. Tout me va \u{1F917}\n\n" +
  "Tu peux par exemple me parler de ton objectif, de ce qui te bloque ou de ce que tu as déjà essayé.";

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

const ALLOWED_EMOJIS = new Set(["😊", "🤗", "🙏", "💚", "✅"]);

function enforceAllowedEmojis(value) {
  const text = cleanReplyText(value);
  return cleanReplyText(
    text.replace(/\p{Extended_Pictographic}\uFE0F?/gu, (emoji) => {
      const normalized = emoji.replace(/\uFE0F/g, "");
      return ALLOWED_EMOJIS.has(emoji) || ALLOWED_EMOJIS.has(normalized)
        ? normalized
        : "";
    })
  );
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
  out = cleanReplyText(out);
  return out || text;
}

// Coaching mode: strip trailing question sentences so Emma cannot keep the
// conversation going from her side. Exceptions: a reply that is entirely one
// clarifying question, and checkout-flow content (a validated customer who
// explicitly asks to buy still gets the country/taste/Control questions).
function stripTrailingCoachingQuestions(value) {
  const text = cleanReplyText(value);
  if (!text) return text;
  if (
    /tr\.ee\/bestellen-|nederland of belgi|welke smaak|chocolade|vanille|half[-\s]?half|\bcontrol\b|ordernummer/i.test(
      text
    )
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

// Removes a repeated Stap 4 website/freebies block from a reply. Only
// called when the website link was already sent earlier AND the customer's
// current message does not explicitly ask for it.
function repeatedContentFallbackForLanguage(language) {
  const copy = {
    nl: "Ik denk graag met je mee op basis van wat je al hebt bekeken 💚",
    en: "I’m happy to help based on what you have already viewed 💚",
    fr: "Je suis là pour t’aider à partir de ce que tu as déjà consulté 💚",
    de: "Ich helfe dir gern auf Basis dessen, was du bereits angesehen hast 💚",
    it: "Ti aiuto volentieri partendo da ciò che hai già visto 💚",
    es: "Estaré encantada de ayudarte a partir de lo que ya has visto 💚",
    pt: "Terei todo o gosto em ajudar com base no que já viste 💚",
    pl: "Chętnie pomogę na podstawie tego, co już udało Ci się zobaczyć 💚",
  };
  return copy[cleanText(language).toLowerCase()] || copy.en;
}

function customerExplicitlyRequestsARepeatedLink(text) {
  return /\b(link|website|site|pagina|página|page|seite|sito|strona|recept|recipe|recette|rezept|ricetta|receta|receita|przepis|kwijt|lost|perdu|verloren|perso|perdido|nogmaals|opnieuw|again|encore|erneut|nuovo|novamente|ponownie|stuur|send|envoie|schick|invia|env[ií]a|envia|wy[sś]lij)\b/i.test(
    cleanText(text)
  );
}

function stripRepeatedWebsiteBlock(value, language = "en") {
  const text = cleanReplyText(value);
  if (!text || !PLAIN_WEBSITE_LINK_PATTERN.test(text)) return text;
  const paragraphs = text.split("\n\n").filter((p) => {
    if (TESTIMONIALS_LINK_PATTERN.test(p) || PROGRAMMA_INFO_LINK_PATTERN.test(p)) {
      return true;
    }
    if (PLAIN_WEBSITE_LINK_PATTERN.test(p)) return false;
    if (/op deze pagina vind je/i.test(p)) return false;
    if (/volledig gratis/i.test(p)) return false;
    if (/kijk welk programma je aanspreekt/i.test(p)) return false;
    if ((p.match(/\u{2705}/gu) || []).length >= 2) return false;
    return true;
  });
  const out = cleanReplyText(paragraphs.join("\n\n"));
  return out || repeatedContentFallbackForLanguage(language);
}

function stripRepeatedTrackedLink(value, pattern, language = "en") {
  const text = cleanReplyText(value);
  if (!text || !pattern.test(text)) return text;
  const paragraphs = text
    .split("\n\n")
    .filter((paragraph) => !pattern.test(paragraph));
  return cleanReplyText(paragraphs.join("\n\n")) ||
    repeatedContentFallbackForLanguage(language);
}

// A later checkout URL is either a requested resend or a changed selection.
// In both cases the payment/freebies sales block has already been delivered.
// This filter removes only those objectively repeated paragraphs; it never
// selects a product, writes a customer sentence or changes the checkout URL.
function stripRepeatedCheckoutExtras(value) {
  const text = cleanReplyText(value);
  if (!text) return text;

  const repeatedPaymentPattern =
    /\b(?:klarna|i\s*deal|ideal|credit\s*card|creditcard|sepa|3\s*(?:termijnen|terms|instalments?|installments?|raten|rate|cuotas|prestazioni|presta[cç][oõ]es|raty)|4\s*(?:maandtermijnen|monthly payments?|mensualit[eé]s|monatsraten|rate mensili|cuotas mensuales|presta[cç][oõ]es mensais|raty miesi[eę]czne))\b/i;
  const repeatedFreebiesPattern =
    /\b(?:gratis extra|free extras?|kostenlos(?:e|en)? extras?|extra gratuit|extras? gratuit|extra gratis|extras? gr[aá]tis|bezp[łl]atne dodatki|persoonlijke coaching|personal coaching|coaching personnel|pers[oö]nliches coaching|coaching personale|coaching personal|besloten whatsapp|private whatsapp|groupe whatsapp|whatsapp-gruppe|gruppo whatsapp|grupo (?:de )?whatsapp|grupa whatsapp|facebook groep|facebook group|groupe facebook|facebook-gruppe|gruppo facebook|grupo (?:de )?facebook|grupa facebook|complete toolkit|recepten|recipes|recettes|rezepte|ricette|recetas|receitas|przepisy|workouts?)\b/i;

  const kept = text
    .split("\n\n")
    .map((paragraph) =>
      paragraph
        .split("\n")
        .filter((line) => {
          if (/https?:\/\/tr\.ee\//i.test(line)) return true;
          if (line.includes("✅")) return false;
          if (repeatedPaymentPattern.test(line)) return false;
          if (/[€£]|\b\d+(?:[,.]\d+)?\s*zł\b/i.test(line)) return false;
          if (repeatedFreebiesPattern.test(line)) return false;
          return true;
        })
        .join("\n")
        .trim()
    )
    .filter(Boolean);

  return cleanReplyText(kept.join("\n\n"));
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
  if (v === "ja" || v === "yes" || v === "wel" || v === "true") return "ja";
  if (v === "nee" || v === "no" || v === "niet" || v === "false") return "nee";
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
  const rawReply = reply === NO_REPLY ? NO_REPLY : enforceAllowedEmojis(reply);

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
  pt: "European Portuguese",
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
      /\b(em portugu[eê]s|portugu[eê]s,? por favor|n[aã]o falo neerland[eê]s|falas portugu[eê]s|continuar em portugu[eê]s)\b/i,
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
// Unknown prefix / BSUID -> "UK" (business decision: UK prices as fallback).
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

function chooseInitialConversationLanguage({
  explicitRequest,
  textLanguage,
  phoneLanguage,
  customerCountry,
}) {
  const country = cleanText(customerCountry).toUpperCase();
  return (
    explicitRequest ||
    (country === "BE" && textLanguage === "fr" ? "fr" : "") ||
    phoneLanguage ||
    (textLanguage && textLanguage !== "other" ? textLanguage : "") ||
    (textLanguage === "other" ? "en" : "") ||
    "nl"
  );
}

function shouldMigrateLegacyPortugueseLanguage({
  storedLanguage,
  customerCountry,
  explicitRequest,
  textLanguage,
}) {
  return (
    cleanText(customerCountry).toUpperCase() === "PT" &&
    ["nl", "en"].includes(normalizeLanguage(storedLanguage)) &&
    !explicitRequest &&
    textLanguage === "pt"
  );
}

function shouldTrustStoredLanguage({ storedLanguage, hasConversationState }) {
  return Boolean(normalizeLanguage(storedLanguage) && hasConversationState);
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

  if (/^\d{10,13}$/.test(raw)) {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return null;
    return raw.length <= 10 ? numeric * 1000 : numeric;
  }

  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

function buildTimingFacts(messages, nowMs = Date.now()) {
  const latestTimedMessage = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find((msg) => parseTimestamp(msg?.timestamp) !== null);
  const previousTimestampMs = latestTimedMessage
    ? parseTimestamp(latestTimedMessage.timestamp)
    : null;
  const elapsedMs = previousTimestampMs === null
    ? null
    : Math.max(0, nowMs - previousTimestampMs);

  return {
    timestamps_available: previousTimestampMs !== null,
    previous_message_timestamp: latestTimedMessage?.timestamp || "",
    elapsed_since_previous_message_ms: elapsedMs,
    within_30_minutes_of_previous_message:
      elapsedMs === null ? null : elapsedMs < 30 * 60 * 1000,
    timing_is_factual_not_pause_intent: true,
  };
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

function messageLooksLikeStep2Checklist(value) {
  const text = String(value || "");
  return (
    text.includes("✅") &&
    text.includes("?") &&
    !/(?:nutritionworks\.online|tr\.ee\/|chat\.whatsapp\.com)/i.test(text)
  );
}

function latestMessageMatching(messages, predicate) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (predicate(messages[index])) return messages[index];
  }
  return null;
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

  const contentMessages = withoutCurrentMessage.filter((msg) => msg.message_text);
  const pinnedMilestones = [
    latestMessageMatching(contentMessages, (msg) =>
      msg.role === "emma" && PLAIN_WEBSITE_LINK_PATTERN.test(msg.message_text)
    ),
    latestMessageMatching(contentMessages, (msg) =>
      msg.role === "emma" && TESTIMONIALS_LINK_PATTERN.test(msg.message_text)
    ),
    latestMessageMatching(contentMessages, (msg) =>
      msg.role === "emma" && PROGRAMMA_INFO_LINK_PATTERN.test(msg.message_text)
    ),
    latestMessageMatching(contentMessages, (msg) =>
      msg.role === "emma" && hasCheckoutLinkBeenSent([msg])
    ),
    latestMessageMatching(contentMessages, (msg) =>
      msg.role === "emma" && /chat\.whatsapp\.com/i.test(msg.message_text)
    ),
    latestMessageMatching(contentMessages, (msg) =>
      msg.role === "emma" && messageLooksLikeStep2Checklist(msg.message_text)
    ),
  ].filter(Boolean);
  const recentTail = contentMessages.slice(-MAX_CONTEXT_MESSAGES);
  const prepared = sortMessagesChronologically(
    uniqueBy([...pinnedMilestones, ...recentTail], (msg) => {
      return `${msg.role}|${normalizeComparableText(msg.message_text)}|${msg.timestamp || ""}`;
    })
  );

  return prepared
    .map((msg) => ({
      role: msg.role || "unknown",
      message_text: clamp(msg.message_text, MAX_MESSAGE_CHARS),
      timestamp: msg.timestamp || "",
    }));
}

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
  // Matches any of the known SKU prices (Control, Basic, Beauty, Deluxe,
  // Exclusive, combos, plus loose upgrade products), in either € notation
  // or "euro" form, plus generic price phrasings.
  const priceRegex =
    /€\s*\d|£\s*\d|\d\s*zł|\d+\s*euro\b|programma kost|kost in totaal|totaalprijs/i;
  return messages.some(
    (msg) => msg.role === "emma" && priceRegex.test(msg.message_text)
  );
}

function hasCheckoutLinkBeenSent(messages) {
  return messages.some(
    (msg) => {
      if (msg.role !== "emma") return false;
      const links = [...cleanText(msg.message_text).matchAll(TREE_LINK_PATTERN)];
      return links.some((match) =>
        APPROVED_CHECKOUT_SLUGS.has(cleanText(match[1]).toLowerCase())
      );
    }
  );
}

const APPROVED_CHECKOUT_SLUGS = new Set([
  "basic-choc", "basic-choc-control", "basic-mix", "basic-mix-control", "basic-van", "basic-van-control",
  "beauty-choc", "beauty-choc-control", "beauty-mix", "beauty-mix-control", "beauty-van", "beauty-van-control",
  "deluxe-choc", "deluxe-choc-control", "deluxe-mix", "deluxe-mix-control", "deluxe-van", "deluxe-van-control",
  "exclusive-choc", "exclusive-choc-control", "exclusive-mix", "exclusive-mix-control", "exclusive-van", "exclusive-van-control",
  "control1x", "fruit-veg-berry-soft", "fruit-veg-soft", "berries", "berries-omega", "berries-soft",
  "fruit-veg-berry", "fruit-vegtables", "essentials-omega", "omegaselection", "superfood",
  "bestellen-be-repen-choc", "bestellen-be-repen-fruit", "bestellen-be-repen-mix", "bestellen-be-soep60",
  "bestellen-nl-luminate15", "bestellen-nl-luminate30", "bestellen-nl-repen-choc", "bestellen-nl-repen-fruit",
  "bestellen-nl-repen-mix", "bestellen-nl-soep30", "bestellen-nl-soep60",
  "baies-4x-fr", "barres-choc-4x-fr", "barres-fruits-4x-fr", "barres-mixte-4x-fr",
  "basic-choc-4x-fr", "basic-choc-control-4x-fr", "basic-mix-control-4x-fr", "basic-mixte-4x-fr", "basic-van-4x-fr", "basic-van-control-4x-fr",
  "beauty-choc-4x-fr", "beauty-choc-control-4x-fr", "beauty-mixte-4x-fr", "beauty-mixte-control-4x-fr", "beauty-van-4x-fr", "beauty-van-control-4x-fr",
  "control-4x-fr", "deluxe-choc-4x-fr", "deluxe-choc-control-4x-fr", "deluxe-mixte-4x-fr", "deluxe-mixte-control-4x-fr", "deluxe-van-4x-fr", "deluxe-van-control-4x-fr",
  "exclusive-choc-4x-fr", "exclusive-choc-control-4x-fr", "exclusive-mixte-4x-fr", "exclusive-mixte-control-4x-fr", "exclusive-van-4x-fr", "exclusive-van-control-4x-fr",
  "fruits-legumes-4x-fr", "fruits-legumes-baies-4x-fr", "fruits-legumes-baies-omega-4x-fr", "omega-4x-fr", "superfood-4x-fr",
]);

const TREE_LINK_PATTERN = /https?:\/\/tr\.ee\/([a-z0-9-]+)/gi;

const FRANCE_PRODUCT_LINKS = new Map([
  ["control1x", "control-4x-fr"],
  ["berries", "baies-4x-fr"],
  ["fruit-vegtables", "fruits-legumes-4x-fr"],
  ["fruit-veg-berry", "fruits-legumes-baies-4x-fr"],
  ["essentials-omega", "fruits-legumes-baies-omega-4x-fr"],
  ["omegaselection", "omega-4x-fr"],
  ["superfood", "superfood-4x-fr"],
  ["bestellen-nl-repen-choc", "barres-choc-4x-fr"],
  ["bestellen-nl-repen-fruit", "barres-fruits-4x-fr"],
  ["bestellen-nl-repen-mix", "barres-mixte-4x-fr"],
  ["bestellen-be-repen-choc", "barres-choc-4x-fr"],
  ["bestellen-be-repen-fruit", "barres-fruits-4x-fr"],
  ["bestellen-be-repen-mix", "barres-mixte-4x-fr"],
]);

const FRANCE_UNIVERSAL_ONLY_SLUGS = new Set([
  "berries-omega",
  "fruit-veg-berry-soft",
  "fruit-veg-soft",
  "berries-soft",
  "bestellen-nl-luminate15",
  "bestellen-nl-luminate30",
  "bestellen-nl-soep30",
  "bestellen-nl-soep60",
]);

function hasExplicitOneTimePaymentRequest(text) {
  return /\b(in (?:één|een) keer|alles (?:in )?(?:één|een) keer|eenmalig|one[-\s]?time|pay in full|single payment|en une seule fois|paiement unique|einmalig|auf einmal|pagamento unico|pago [uú]nico|de uma s[oó] vez|jednorazowo)\b/i.test(
    cleanText(text)
  );
}

function mapCheckoutLinkForCountry(slug, customerCountry) {
  const country = cleanText(customerCountry).toUpperCase();
  const normalizedSlug = cleanText(slug).toLowerCase();
  const universal = slug.match(
    /^(basic|beauty|deluxe|exclusive)-(van|choc|mix)(-control)?$/i
  );
  const france = slug.match(
    /^(basic|beauty|deluxe|exclusive)-(van|choc|mixte|mix)(-control)?-4x-fr$/i
  );

  if (country === "FR" && universal) {
    const [, program, taste, control = ""] = universal;
    const franceTaste = taste.toLowerCase() === "mix"
      ? program.toLowerCase() === "basic" && control
        ? "mix"
        : "mixte"
      : taste.toLowerCase();
    return `${program.toLowerCase()}-${franceTaste}${control.toLowerCase()}-4x-fr`;
  }

  if (country === "FR" && FRANCE_PRODUCT_LINKS.has(normalizedSlug)) {
    return FRANCE_PRODUCT_LINKS.get(normalizedSlug);
  }

  if (country !== "FR" && france) {
    const [, program, taste, control = ""] = france;
    const titleProgram = program.charAt(0).toUpperCase() + program.slice(1).toLowerCase();
    const titleTaste = taste.toLowerCase().startsWith("mix")
      ? "Mix"
      : taste.charAt(0).toUpperCase() + taste.slice(1).toLowerCase();
    return `${titleProgram}-${titleTaste}${control ? "-Control" : ""}`;
  }

  if (country !== "FR") {
    for (const [universalSlug, franceSlug] of FRANCE_PRODUCT_LINKS) {
      if (franceSlug !== normalizedSlug) continue;
      if (/^bestellen-(?:nl|be)-repen-/.test(universalSlug)) {
        const taste = normalizedSlug.match(/^barres-(choc|fruits|mixte)-4x-fr$/)?.[1];
        const market = country === "BE" ? "be" : "nl";
        const localTaste = taste === "fruits" ? "fruit" : taste === "mixte" ? "mix" : "choc";
        return `bestellen-${market}-repen-${localTaste}`;
      }
      return universalSlug;
    }
  }

  return slug;
}

function enforceTechnicalCheckoutLinks({
  reply,
  customerCountry,
  language,
  currentMessage,
  recentMessages,
}) {
  const text = cleanReplyText(reply);
  const links = [...text.matchAll(TREE_LINK_PATTERN)];
  if (links.length === 0) {
    return { reply: text, changed: false, reason: "no_checkout_link" };
  }
  if (links.length > 1) {
    return {
      reply: fallbackReplyForLanguage(language),
      changed: true,
      reason: "multiple_checkout_links_blocked",
    };
  }

  const match = links[0];
  const originalUrl = match[0];
  const slug = cleanText(match[1]).toLowerCase();
  const country = cleanText(customerCountry).toUpperCase();
  if (!APPROVED_CHECKOUT_SLUGS.has(slug)) {
    return {
      reply: fallbackReplyForLanguage(language),
      changed: true,
      reason: "unknown_checkout_link_blocked",
    };
  }

  if (country === "PT" && /(?:^control1x$|-control(?:-|$)|^control-4x-fr$)/i.test(slug)) {
    return {
      reply: fallbackReplyForLanguage(language),
      changed: true,
      reason: "portugal_control_link_blocked",
    };
  }

  if (
    country === "BE" &&
    /^(?:superfood|bestellen-nl-luminate(?:15|30)|bestellen-nl-soep30)$/i.test(slug)
  ) {
    return {
      reply: fallbackReplyForLanguage(language),
      changed: true,
      reason: "belgium_unavailable_product_link_blocked",
    };
  }

  const previousCheckoutLink = findLastEmmaCheckoutLink(recentMessages, "");
  const previousCheckoutSlug =
    previousCheckoutLink.match(/https?:\/\/tr\.ee\/([a-z0-9-]+)/i)?.[1] || "";
  const previousWasOneTime =
    country === "FR" &&
    Boolean(previousCheckoutLink) &&
    /^(?:basic|beauty|deluxe|exclusive)-(?:van|choc|mix)(?:-control)?$/i.test(
      previousCheckoutSlug
    );
  const oneTimeRequestInHistory = (Array.isArray(recentMessages)
    ? recentMessages
    : []
  ).some(
    (message) =>
      message.role === "user" &&
      hasExplicitOneTimePaymentRequest(message.message_text)
  );
  const franceOneTimeAllowed =
    country === "FR" &&
    (previousWasOneTime ||
      oneTimeRequestInHistory ||
      hasExplicitOneTimePaymentRequest(currentMessage));
  const isFranceLink = /-4x-fr$/i.test(slug);

  if (country !== "FR" && isFranceLink) {
    const mappedSlug = mapCheckoutLinkForCountry(slug, country);
    if (mappedSlug !== slug && APPROVED_CHECKOUT_SLUGS.has(mappedSlug.toLowerCase())) {
      return {
        reply: text.replace(originalUrl, `https://tr.ee/${mappedSlug}`),
        changed: true,
        reason: "france_programme_link_corrected_for_other_country",
      };
    }
    return {
      reply: fallbackReplyForLanguage(language),
      changed: true,
      reason: "france_only_link_blocked",
    };
  }

  if (
    country === "FR" &&
    !isFranceLink &&
    !franceOneTimeAllowed &&
    !FRANCE_UNIVERSAL_ONLY_SLUGS.has(slug)
  ) {
    const mappedSlug = mapCheckoutLinkForCountry(slug, country);
    if (mappedSlug !== slug && APPROVED_CHECKOUT_SLUGS.has(mappedSlug.toLowerCase())) {
      return {
        reply: text.replace(originalUrl, `https://tr.ee/${mappedSlug}`),
        changed: true,
        reason: "programme_link_corrected_for_france",
      };
    }
    return {
      reply: fallbackReplyForLanguage(language),
      changed: true,
      reason: "non_france_link_blocked_for_france",
    };
  }

  return { reply: text, changed: false, reason: "checkout_link_valid" };
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
    (msg) => msg.role === "emma" && /ordernummer/i.test(msg.message_text)
  );
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
// Once triggered, derives only verified purchase facts. Programme interest,
// comparison and doubt remain contextual CRM facts handled by the extractor.

// Juice Plus order numbers always start with "JP04", followed by a
// customer-specific code. "JP04" alone is not enough: require at least
// three extra characters after the prefix.
const ORDER_NUMBER_PATTERN = /\bJP04[-_]?[A-Z0-9]{3,}\b/i;
const PROGRAM_PATTERN_GLOBAL = /\b(basic|beauty|deluxe|exclusive)\b/gi;
const CONTROL_COMBO_PATTERN =
  /(?:\bmet[\s-]*(?:de[\s-]*)?control|\ben[\s-]*(?:de[\s-]*)?control|\binclusief[\s-]*control|\bcontrol[\s-]*erbij|(?:^|\s|\W)\+[\s-]*control)/i;

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
    const tasteToken = franceMatch[2].toLowerCase();
    const taste = tasteToken === "van"
      ? "vanilla"
      : tasteToken === "choc"
        ? "chocolate"
        : "mix";
    const hasControl = Boolean(franceMatch[3]);
    return { program, taste, hasControl, paymentMode: "france_4x" };
  }
  if (/tr\.ee\/control-4x-fr(?:\b|\/|\?|$)/i.test(url)) {
    return { program: "", taste: "", hasControl: true, paymentMode: "france_4x" };
  }

  // Universal links (2026): tr.ee/Basic-Van, tr.ee/Deluxe-Mix-Control, ...
  const universalMatch = url.match(
    /tr\.ee\/(basic|beauty|deluxe|exclusive)-(van|choc|mix)(-control)?/i
  );
  if (universalMatch) {
    const lower = universalMatch[1].toLowerCase();
    const program = lower.charAt(0).toUpperCase() + lower.slice(1);
    const tasteToken = universalMatch[2].toLowerCase();
    const taste = tasteToken === "van"
      ? "vanilla"
      : tasteToken === "choc"
        ? "chocolate"
        : "mix";
    const hasControl = Boolean(universalMatch[3]);
    return { program, taste, hasControl, paymentMode: "one_time" };
  }
  if (/tr\.ee\/control1x(?:\b|\/|\?|$)/i.test(url)) {
    return { program: "", taste: "", hasControl: true, paymentMode: "one_time" };
  }

  // Legacy country links, kept so running conversations still validate.
  const programMatch = url.match(
    /tr\.ee\/bestellen-(?:nl|be)-(basic|beauty|deluxe|exclusive)(?:-(choc|van|mix))?(-control)?/i
  );
  if (programMatch) {
    const lower = programMatch[1].toLowerCase();
    const program = lower.charAt(0).toUpperCase() + lower.slice(1);
    const tasteToken = cleanText(programMatch[2]).toLowerCase();
    const taste = tasteToken === "van"
      ? "vanilla"
      : tasteToken === "choc"
        ? "chocolate"
        : tasteToken === "mix"
          ? "mix"
          : "";
    const hasControl = Boolean(programMatch[3]);
    return { program, taste, hasControl, paymentMode: "one_time" };
  }
  if (/tr\.ee\/bestellen-(?:nl|be)-control(?:\b|\/|\?|$)/i.test(url)) {
    return { program: "", taste: "", hasControl: true, paymentMode: "one_time" };
  }

  return null;
}

// Walks backward through Emma's messages to find the most recent tr.ee
// checkout URL she sent. Prefers the current reply if it contains a link.
function findLastEmmaCheckoutLink(messages, currentReply) {
  const findApprovedLink = (value) => {
    const links = [...cleanText(value).matchAll(TREE_LINK_PATTERN)];
    const approved = links.find((match) =>
      APPROVED_CHECKOUT_SLUGS.has(cleanText(match[1]).toLowerCase())
    );
    return approved?.[0] || "";
  };

  if (currentReply) {
    const link = findApprovedLink(currentReply);
    if (link) return link;
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "emma" && msg.message_text) {
      const link = findApprovedLink(msg.message_text);
      if (link) return link;
    }
  }

  return "";
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

function derivePurchaseFields({
  recentMessages,
  currentUserMessage,
  currentReply,
}) {
  // Hard gate: a valid JP04 order number from the user AND a checkout link
  // sent by Emma. The checkout URL is the canonical purchased SKU.
  const orderNumberPresent = userMessagesContainOrderNumber(
    recentMessages,
    currentUserMessage
  );

  const checkoutLink = findLastEmmaCheckoutLink(recentMessages, currentReply);
  const validated = orderNumberPresent && Boolean(checkoutLink);

  if (!validated) {
    return {
      validated: false,
      purchased_program: "",
      has_control: "",
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
    /\b(besteld|order|ordernummer|betaald|gekocht|whatsapp.?groep|groep|toegang)\b/i.test(
      latest
    );
  const hasExplicitBuyingIntent =
    /\b(bestellen|starten|ik wil starten|hoe bestel|link|kopen|aanschaffen|doorgaan)\b/i.test(
      latest
    );

  const lowIntent =
    /^(ok|oke|ja|nee|weet niet|misschien|kan|vertel maar|hoe bedoel je|prima|goed|klinkt goed)\.?$/i.test(
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
    is_low_intent: lowIntent,
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
  const lastCheckoutLink = findLastEmmaCheckoutLink(recent_messages, "");
  const lastCheckoutSelection = parseCheckoutLinkSKU(lastCheckoutLink);
  const whatsappGroupLinkAlreadySent = hasWhatsappGroupLinkBeenSent(recent_messages);
  const orderNumberAlreadyAsked = hasAskedOrderNumber(recent_messages);

  const validatedCustomer = isCustomerStatusValidated(
    customer_status,
    recent_messages
  );
  const timingFacts = buildTimingFacts(recent_messages);

  const context = {
    agent_name: "Emma",
    runtime_state: {
      ...state,
      website_link_already_sent: websiteLinkAlreadySent,
      testimonials_link_already_sent: testimonialsLinkAlreadySent,
      programma_info_link_already_sent: programmaInfoLinkAlreadySent,
      price_already_mentioned: priceAlreadyMentioned,
      checkout_link_already_sent: checkoutLinkAlreadySent,
      last_checkout_link: lastCheckoutLink,
      last_checkout_selection: lastCheckoutSelection,
      whatsapp_group_link_already_sent: whatsappGroupLinkAlreadySent,
      order_number_already_asked: orderNumberAlreadyAsked,
      conversation_language: cleanText(conversation_language) || "nl",
      customer_country: cleanText(customer_country) || "UNKNOWN",
      order_validation_server_side: true,
      pause_timing: timingFacts,
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
      timestamp: msg.timestamp || "",
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
        "Vraag NOOIT of de klant er nog is en jaag nooit op (geen Ben je er nog, Lukt het, Heb je al gekeken). Een emoji of kort bericht is een gewoon bericht: reageer er kort en warm op. Follow-ups gebeuren handmatig, nooit door jou.",
        "Gebruik pause_timing uitsluitend als feitelijke tijdinformatie. Alleen de volledige gesprekscontext bepaalt of werkelijk een tijdelijke pauze was aangekondigd; tijd of een kort bericht op zichzelf bewijst dat nooit.",
        "Als website_link_already_sent true is: stuur de website-link en het freebies-blok NOOIT opnieuw, tenzij de klant er expliciet om vraagt. Geef bij twijfel kort persoonlijk advies in eigen woorden, zonder link.",
        "Als testimonials_link_already_sent true is: stuur de testimonials-link NIET opnieuw, tenzij de klant er expliciet om vraagt — verwijs in woorden naar de resultatenpagina.",
        "Als programma_info_link_already_sent true is: stuur de programma-uitleg link NIET opnieuw, tenzij de klant er expliciet om vraagt.",
        "Uitleggen betekent uitleggen in eigen woorden. Een link sturen is geen uitleg; stuur nooit een eerder gestuurde link opnieuw als vervanging van uitleg.",
        "Als price_already_mentioned true is: noem de prijs niet opnieuw, tenzij de klant ernaar vraagt.",
        "Vraag NOOIT naar het land van de klant. De checkout-links zijn universeel en openen automatisch in het juiste land met de juiste prijzen.",
        "Als checkout_link_already_sent true is: last_checkout_link en last_checkout_selection zijn de technische waarheid over de laatst verstuurde combinatie. Behoud die keuzes bij een technisch probleem. Stuur alleen een nieuwe link als de klant expliciet om dezelfde link vraagt of een keuze wijzigt; herhaal nooit het betaal- of freebiesblok.",
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
    "interested_in_program_update — Welk ene specifieke programma (Basic, Beauty, Deluxe of Exclusive) de klant zelf duidelijk verkiest of kiest.",
    "- Geldige waarden: Basic / Beauty / Deluxe / Exclusive / (lege string).",
    "- Alleen een duidelijke voorkeur, interesse in één programma of definitieve keuze telt.",
    "- Alleen een programmanaam noemen is niet genoeg. Noemt de klant meerdere programma's, vergelijkt die of twijfelt ertussen, retourneer dan altijd een lege string.",
    "- Kies nooit zelf één programma uit meerdere genoemde opties en kopieer nooit een advies van Emma als klantkeuze.",
    "- Algemene koopintentie, het bestellen van Control, of interesse in afvallen tellen NIET als programma-interesse.",
    "- Kies nooit een default programma. Verzin nooit een programma.",
    "",
    "interested_in_control_update — Of de klant aantoonbaar positieve interesse toont in Control.",
    "- Geldige waarden: ja / (lege string).",
    "- Vul \"ja\" alleen in bij een contextueel duidelijke positieve uitspraak of keuze van de klant, inclusief een kort antwoord zoals 'ja' wanneer uit het volledige gesprek blijkt dat dit de openstaande Control-vraag beantwoordt.",
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
        const lastCheckoutLink = findLastEmmaCheckoutLink(recentMessages, "");
        const lastCheckoutSelection = parseCheckoutLinkSKU(lastCheckoutLink);
        const guardPriceMentioned = hasPriceBeenMentioned(recentMessages);
        const guardLines = [];
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
            `TECHNISCH FEIT: er is al een checkout-link gestuurd. De laatst verstuurde URL is ${lastCheckoutLink || "onbekend"} en de technisch gelezen selectie is ${JSON.stringify(lastCheckoutSelection || {})}. Deze bestaande keuzes blijven gelden tijdens een checkoutprobleem en mogen niet opnieuw worden gevraagd. Bij een expliciete wijziging of verzoek om dezelfde link mag je de juiste link sturen, maar herhaal het freebiesblok en de betaaluitleg nooit.`
          );
        }
        if (guardPriceMentioned) {
          guardLines.push(
            "De prijs is AL genoemd. Niet herhalen, tenzij de klant ernaar vraagt."
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

  // A stored language wins only when other conversation state exists as well.
  // If a test/customer record was cleared but an old language value still
  // arrives from another layer, it must not revive that stale language.
  const hasConversationState = Boolean(
    normalizedCustomerStatus ||
      normalizedCurrentPhase ||
      normalizedGoal ||
      normalizedObjections ||
      normalizedLastSummary ||
      normalizedInterestedInProgram ||
      normalizedInterestedInControl ||
      normalizedPurchasedProgram ||
      normalizedHasControl ||
      (Array.isArray(recent_messages) &&
        recent_messages.some((item) =>
          cleanText(item?.message_text ?? item?.text ?? item?.message)
        ))
  );
  const suppliedLanguage = normalizeLanguage(language);
  const storedLanguage = shouldTrustStoredLanguage({
    storedLanguage: suppliedLanguage,
    hasConversationState,
  })
    ? suppliedLanguage
    : "";
  // Customer country and conversation language are separate. The phone
  // country is resolved first so a +31 number cannot be misclassified as
  // German by statistical detection of a short Dutch opening message.
  const customerCountry = detectCountryFromPhone(normalizedUserId) || "UNKNOWN";

  let conversationLanguage = storedLanguage;
  let languageUpdate = "";
  if (!conversationLanguage) {
    const explicitRequest = detectExplicitLanguageRequest(normalizedMessage);
    const fromPhone = detectLanguageFromPhone(normalizedUserId);
    const fromText = detectLanguageFromText(normalizedMessage);
    conversationLanguage = chooseInitialConversationLanguage({
      explicitRequest,
      textLanguage: fromText,
      phoneLanguage: fromPhone,
      customerCountry,
    });
    languageUpdate = conversationLanguage;
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

  // Language switching for known customers: ONLY an explicit request
  // ("can we speak English?", "auf Deutsch bitte") switches the language,
  // at any point in the conversation, and re-locks it. There is deliberately
  // no statistical switching — writing style alone never changes the
  // conversation language.
  if (storedLanguage) {
    const explicitRequest = detectExplicitLanguageRequest(normalizedMessage);
    if (explicitRequest && explicitRequest !== conversationLanguage) {
      conversationLanguage = explicitRequest;
      languageUpdate = explicitRequest;
    } else {
      const textLanguage = detectLanguageFromText(normalizedMessage);
      if (
        shouldMigrateLegacyPortugueseLanguage({
          storedLanguage,
          customerCountry,
          explicitRequest,
          textLanguage,
        })
      ) {
        conversationLanguage = "pt";
        languageUpdate = "pt";
      }
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
        reply:
          customerCountry === "FR"
            ? FRANCE_WELCOME_MESSAGES[conversationLanguage] || FRANCE_WELCOME_MESSAGES.fr
            : WELCOME_MESSAGES[conversationLanguage] || WELCOME_MESSAGE,
        language: conversationLanguage,
        language_update: languageUpdate,
      })
    );
  }

  if (!agentId) {
    console.error("CONFIG ERROR: ELEVENLABS_AGENT_ID ontbreekt");
    return sendDiagResponse("fallback_reply", buildResponse({ send_reply: true, reply: fallbackReplyForLanguage(conversationLanguage), language: conversationLanguage }));
  }

  try {
    const alreadyValidated = isCustomerStatusValidated(
      normalizedCustomerStatus,
      normalizedRecentMessages
    );

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

    // Backstop: the Stap 4 website/freebies block is sent once. If it was
    // already sent and the customer did not explicitly ask for it (or for
    // recipes/inspiration), a repeated block is removed from the reply.
    const explicitRepeatedLinkRequest =
      customerExplicitlyRequestsARepeatedLink(normalizedMessage);
    if (
      hasPatternBeenSent(normalizedRecentMessages, PLAIN_WEBSITE_LINK_PATTERN) &&
      !explicitRepeatedLinkRequest
    ) {
      reply = stripRepeatedWebsiteBlock(reply, conversationLanguage);
    }
    if (
      hasPatternBeenSent(normalizedRecentMessages, TESTIMONIALS_LINK_PATTERN) &&
      !explicitRepeatedLinkRequest
    ) {
      reply = stripRepeatedTrackedLink(
        reply,
        TESTIMONIALS_LINK_PATTERN,
        conversationLanguage
      );
    }
    if (
      hasPatternBeenSent(normalizedRecentMessages, PROGRAMMA_INFO_LINK_PATTERN) &&
      !explicitRepeatedLinkRequest
    ) {
      reply = stripRepeatedTrackedLink(
        reply,
        PROGRAMMA_INFO_LINK_PATTERN,
        conversationLanguage
      );
    }

    const checkoutSafety = enforceTechnicalCheckoutLinks({
      reply,
      customerCountry,
      language: conversationLanguage,
      currentMessage: normalizedMessage,
      recentMessages: normalizedRecentMessages,
    });
    reply = checkoutSafety.reply;
    if (checkoutSafety.changed) {
      diag("CHECKOUT_LINK_TECHNICAL_CONTROL", {
        reason: checkoutSafety.reason,
      });
    }

    // If any approved checkout link was already sent, every later checkout
    // link is a resend or replacement. The initial payment/freebies block is
    // therefore technically non-repeatable, regardless of Emma's wording.
    const previousCheckoutLink = findLastEmmaCheckoutLink(
      normalizedRecentMessages,
      ""
    );
    const currentReplyCheckoutLink = findLastEmmaCheckoutLink([], reply);
    if (previousCheckoutLink && currentReplyCheckoutLink) {
      const beforeCheckoutRepeatFilter = reply;
      reply = stripRepeatedCheckoutExtras(reply);
      if (reply !== beforeCheckoutRepeatFilter) {
        diag("REPEATED_CHECKOUT_EXTRAS_REMOVED", {
          previous_checkout_link: previousCheckoutLink,
          current_checkout_link: currentReplyCheckoutLink,
        });
      }
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
    const derivedPurchase = derivePurchaseFields({
      recentMessages: normalizedRecentMessages,
      currentUserMessage: normalizedMessage,
      currentReply: reply,
    });

    // customer_status is purely server-side (order control + self-healing).
    // current_phase can come from the extractor, but self-healing overrides it
    // to "coaching" once the customer is validated.
    const finalCustomerStatusUpdate = selfHealCustomerStatus;
    const finalCurrentPhaseUpdate =
      selfHealCurrentPhase || extraction.current_phase_update;

    // Purchase facts remain deterministic. Interest and doubt are semantic,
    // so those two fields come from the contextual extractor.
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
  console.log(`${SERVER_BUILD_ID} draait op poort ${PORT}`);
});
