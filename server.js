import express from "express";
import WebSocket from "ws";
import OpenAI from "openai";
import dotenv from "dotenv";
import { randomUUID } from "crypto";

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

const MAX_CONTEXT_MESSAGES = Number(process.env.MAX_CONTEXT_MESSAGES || 12);
const MAX_MESSAGE_CHARS = Number(process.env.MAX_MESSAGE_CHARS || 500);
const MAX_SUMMARY_CHARS = Number(process.env.MAX_SUMMARY_CHARS || 900);
const MAX_GOAL_CHARS = Number(process.env.MAX_GOAL_CHARS || 300);
const MAX_OBJECTIONS_CHARS = Number(process.env.MAX_OBJECTIONS_CHARS || 400);
const MAX_SHORT_FIELD_CHARS = Number(process.env.MAX_SHORT_FIELD_CHARS || 30);

const NO_REPLY = "__NO_REPLY__";

const FALLBACK_REPLY =
  "Er ging iets mis met mijn antwoord, kun je je bericht nog een keer sturen";

const WELCOME_MESSAGE =
  "Hallo, ik ben Emma 😊\n\n" +
  "Ik ben de AI-assistent van Nutrition Works en ik help dagelijks mensen om hun doelen te bereiken 🤗✨\n\n" +
  "We hebben al tienduizenden mensen geholpen en ik denk echt dat ik jou ook kan helpen 💚\n\n" +
  "Om je zo goed mogelijk te helpen, mag je me meteen wat meer vertellen over jouw situatie 🙏\n\n" +
  "Bijvoorbeeld:\n" +
  "• je huidige gewicht\n" +
  "• waar je naartoe wil\n" +
  "• je leeftijd\n" +
  "• wat je al geprobeerd hebt\n" +
  "• waar je nu tegenaan loopt\n\n" +
  "Hoe meer je deelt, hoe beter ik je kan helpen 🤗";

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
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
  };
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

  return withoutCurrentMessage
    .filter((msg) => msg.message_text)
    .slice(-MAX_CONTEXT_MESSAGES)
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

function hasLinkBeenSent(messages, linkPart) {
  const needle = cleanText(linkPart).toLowerCase();
  if (!needle) return false;

  return messages.some(
    (msg) =>
      msg.role === "emma" &&
      cleanText(msg.message_text).toLowerCase().includes(needle)
  );
}

function hasPriceBeenMentioned(messages) {
  // Matches any of the known SKU prices (Control, Basic, Beauty, Deluxe,
  // Exclusive, combos, plus loose upgrade products), in either € notation
  // or "euro" form, plus generic price phrasings.
  const priceRegex =
    /€\s*(?:54|99|108|123|135|194|199|204|223|254|346|358|379|417|477|481|600|602|725)\b|(?:54|99|108|123|135|194|199|204|223|254|346|358|379|417|477|481|600|602|725)\s*euro\b|programma kost|kost in totaal|totaalprijs/i;

  return messages.some(
    (msg) => msg.role === "emma" && priceRegex.test(msg.message_text)
  );
}

function hasCheckoutLinkBeenSent(messages) {
  // Matches any of the real tr.ee checkout URLs. Covers Control, all 4 program
  // SKUs, all program+Control combos, loose upgrade products (Berry caps,
  // Fruit/Vegetable caps, Berry+Fruit/Vegetable combos), extra products
  // (Omega, Complete Bars, Superfood, Luminate, Vegetable Soup), in both
  // Dutch and Belgian markets.
  return messages.some(
    (msg) =>
      msg.role === "emma" &&
      /tr\.ee\/bestellen-(?:nl|be)-/i.test(msg.message_text)
  );
}

function hasWhatsappGroupLinkBeenSent(messages) {
  return messages.some(
    (msg) =>
      msg.role === "emma" &&
      /chat\.whatsapp\.com/i.test(msg.message_text)
  );
}

function hasAskedCountry(messages) {
  return messages.some(
    (msg) =>
      msg.role === "emma" &&
      /nederland of belgi[eë]|welk land|in welk land/i.test(msg.message_text)
  );
}

function hasAskedOrderNumber(messages) {
  return messages.some(
    (msg) => msg.role === "emma" && /ordernummer/i.test(msg.message_text)
  );
}

function hasAskedTaste(messages) {
  return messages.some(
    (msg) =>
      msg.role === "emma" &&
      /welke smaak|chocolade.*vanille|vanille.*chocolade|half-half|smaak complete/i.test(
        msg.message_text
      )
  );
}

function hasReceivedCountryAnswer(messages) {
  return messages.some(
    (msg) =>
      msg.role === "user" &&
      (/\b(nederland|belgi[eë])(?![a-z])/i.test(msg.message_text) ||
        /(?:^|\s)(nl|be)(?:$|\s|[\.!,?])/i.test(msg.message_text))
  );
}

function hasReceivedTasteAnswer(messages) {
  return messages.some(
    (msg) =>
      msg.role === "user" &&
      /\b(chocola(?:de|t)?|vanille|half[-\s]?half|half|mix|gemengd)\b/i.test(
        msg.message_text
      )
  );
}

// Detects whether the user has explicitly answered Emma's "wil je Control
// erbij?" upsell question in the checkout flow. Looks for affirmative or
// negative responses around Control, plus standalone yes/no answers that
// immediately follow Emma's combo question containing "Control".
function hasReceivedControlAnswer(messages) {
  // Find the most recent Emma message that asks about Control.
  // Matches several common phrasings of the upsell question:
  //   - "Control er gelijk bij doen"
  //   - "Control erbij doen"
  //   - "Control er bij"
  //   - "Control toevoegen"
  //   - "ook Control"
  const emmaControlQuestionPattern =
    /control\s+(?:er\s*(?:gelijk\s+)?bij|toevoegen)|\book\s+control\b/i;

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

    // Explicit Control yes/no
    if (
      /\b(ja|jazeker|graag|prima|zeker|doe maar|inderdaad|natuurlijk).{0,30}control\b/i.test(
        text
      )
    )
      return true;
    if (
      /\bcontrol.{0,30}(ja|jazeker|graag|prima|zeker|doe maar|inderdaad|natuurlijk)\b/i.test(
        text
      )
    )
      return true;
    if (
      /\b(nee|geen|zonder|liever niet|laat maar).{0,30}control\b/i.test(text)
    )
      return true;
    if (
      /\bcontrol.{0,30}(nee|geen|zonder|liever niet|laat maar|niet)\b/i.test(
        text
      )
    )
      return true;

    // Standalone yes/no when Emma's last question contained Control
    if (lastEmmaIndexWithControlAsk >= 0) {
      // Standalone affirmative answers (single or short combinations).
      // The "doe\s*maa?r[ts]?" pattern matches "doe maar", "doemaar",
      // "doe maart" (common typo with extra t), "doe mar", etc.
      if (
        /^\s*(?:ja|jazeker|graag|prima|doe\s*maa?r[ts]?|inderdaad|natuurlijk|zeker|oke|ok|jep|yes|sure)(?:\s+(?:graag|zeker|prima|doe\s*maa?r[ts]?|natuurlijk))?\s*[\.!]?\s*$/i.test(
          text
        )
      )
        return true;
      // Standalone negative answers (single or short combinations)
      if (
        /^\s*(?:nee|nope|geen|niks)(?:\s+(?:dank\s+je|bedankt|laat\s+maar|hoor|joh))?\s*[\.!]?\s*$/i.test(
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

const ORDER_NUMBER_PATTERN = /\bJP[-_]?[A-Z0-9]+\b/i;
const PROGRAM_PATTERN = /\b(basic|beauty|deluxe|exclusive)\b/i;
const PROGRAM_PATTERN_GLOBAL = /\b(basic|beauty|deluxe|exclusive)\b/gi;
const CONTROL_MENTION_PATTERN = /\bcontrol\b/i;
const CONTROL_COMBO_PATTERN =
  /(?:\bmet[\s-]*(?:de[\s-]*)?control|\ben[\s-]*(?:de[\s-]*)?control|\binclusief[\s-]*control|\bcontrol[\s-]*erbij|(?:^|\s|\W)\+[\s-]*control)/i;

// Parses a tr.ee checkout URL and extracts the SKU components:
// program (Basic/Beauty/Deluxe/Exclusive or empty for Control-only) and
// whether Control is included. The URL contains the canonical truth about
// what the customer was actually directed to buy, which is more reliable
// than parsing Emma's natural-language confirmation text.
function parseCheckoutLinkSKU(url) {
  if (!url) return null;

  const programMatch = url.match(
    /tr\.ee\/bestellen-(?:nl|be)-(basic|beauty|deluxe|exclusive)(?:-(?:choc|van|mix))?(-control)?/i
  );
  if (programMatch) {
    const lower = programMatch[1].toLowerCase();
    const program = lower.charAt(0).toUpperCase() + lower.slice(1);
    const hasControl = Boolean(programMatch[2]);
    return { program, hasControl };
  }

  if (/tr\.ee\/bestellen-(?:nl|be)-control(?:\b|\/|\?|$)/i.test(url)) {
    return { program: "", hasControl: true };
  }

  return null;
}

// Walks backward through Emma's messages to find the most recent tr.ee
// checkout URL she sent. Prefers the current reply if it contains a link.
function findLastEmmaCheckoutLink(messages, currentReply) {
  const urlRegex = /(https?:\/\/tr\.ee\/bestellen-[a-z0-9-]+)/i;

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

function extractInterestedInProgram(messages, currentUserMessage, currentReply) {
  // Interest in a program can be expressed anywhere in the conversation by
  // either Emma (offer) or the user (request). Take the LAST mention.
  let lastMatch = "";

  for (const msg of messages) {
    const found = findProgramInText(cleanText(msg.message_text));
    if (found) lastMatch = found;
  }
  const userFound = findProgramInText(cleanText(currentUserMessage));
  if (userFound) lastMatch = userFound;
  const replyFound = findProgramInText(cleanText(currentReply));
  if (replyFound) lastMatch = replyFound;

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

function deriveInterestedInControl(messages, currentUserMessage, currentReply) {
  // Customers come in for Control, so "ja" is the safe default once Control
  // has been mentioned anywhere in the conversation by user or Emma.
  const allTexts = [];
  for (const msg of messages) {
    if (msg.message_text) allTexts.push(cleanText(msg.message_text));
  }
  if (currentUserMessage) allTexts.push(cleanText(currentUserMessage));
  if (currentReply) allTexts.push(cleanText(currentReply));

  const joined = allTexts.join(" ");
  return CONTROL_MENTION_PATTERN.test(joined) ? "ja" : "";
}

function derivePurchaseFields({
  recentMessages,
  currentUserMessage,
  currentReply,
  whatsappGroupLinkSentNowOrEarlier,
}) {
  // Hard gate: order number from user AND WhatsApp group link sent.
  const orderNumberPresent = userMessagesContainOrderNumber(
    recentMessages,
    currentUserMessage
  );

  const validated = orderNumberPresent && whatsappGroupLinkSentNowOrEarlier;

  // interested_in_program / interested_in_control can be derived independently
  // of the purchase trigger (a customer can be "interested" before buying).
  const interestedInProgram = extractInterestedInProgram(
    recentMessages,
    currentUserMessage,
    currentReply
  );
  const interestedInControlSignal = deriveInterestedInControl(
    recentMessages,
    currentUserMessage,
    currentReply
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
    interested_in_control: interestedInControlSignal || "ja",
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
    /\b(medicatie|medicijnen|zwanger|borstvoeding|diabetes|hart|lever|nieren|darmziekte|eetstoornis|arts|apotheker|veilig bij|mag dit met)\b/i.test(
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

  const testimonialAlreadySent = hasLinkBeenSent(
    recent_messages,
    "youtube.com/@Nutrition-Works"
  );

  const priceAlreadyMentioned = hasPriceBeenMentioned(recent_messages);
  const checkoutLinkAlreadySent = hasCheckoutLinkBeenSent(recent_messages);
  const whatsappGroupLinkAlreadySent = hasWhatsappGroupLinkBeenSent(recent_messages);
  const countryAlreadyAsked = hasAskedCountry(recent_messages);
  const tasteAlreadyAsked = hasAskedTaste(recent_messages);
  const countryAnswerReceived = hasReceivedCountryAnswer(recent_messages);
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
      testimonial_already_sent: testimonialAlreadySent,
      price_already_mentioned: priceAlreadyMentioned,
      checkout_link_already_sent: checkoutLinkAlreadySent,
      whatsapp_group_link_already_sent: whatsappGroupLinkAlreadySent,
      country_already_asked: countryAlreadyAsked,
      taste_already_asked: tasteAlreadyAsked,
      country_answer_received: countryAnswerReceived,
      taste_answer_received: tasteAnswerReceived,
      control_answer_received: controlAnswerReceived,
      order_number_already_asked: orderNumberAlreadyAsked,
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
      timestamp: msg.timestamp || "",
    })),
    repetition_guard: {
      do_not_repeat_these_recent_emma_messages: lastEmmaMessages,
      last_user_messages_for_context_only: lastUserMessages,
      rules: [
        "Antwoord alleen op het nieuwste klantbericht.",
        "Gebruik bekende CRM-data als achtergrond, niet als tekst om opnieuw op te sommen.",
        "Herhaal geen vraag, uitleg, prijs, testimonial-link, checkout-link of ordernummer-instructie die al in de recente Emma-berichten staat.",
        "Als iets al bekend is uit goal, objections, last_summary of recent_conversation_history: vraag er niet opnieuw naar.",
        "Als het gesprek bestaand is: stel jezelf niet opnieuw voor en gebruik geen startbericht.",
        "Als testimonial_already_sent true is: stuur de testimonial-link niet opnieuw, tenzij de klant er expliciet om vraagt.",
        "Als price_already_mentioned true is: noem de prijs niet opnieuw, tenzij de klant ernaar vraagt.",
        "Als country_already_asked true is: vraag niet opnieuw naar Nederland of België, tenzij het antwoord nog ontbreekt en het direct nodig is voor checkout.",
        "Als checkout_link_already_sent true is: stuur geen nieuwe checkout-link, tenzij de klant er expliciet opnieuw om vraagt.",
        "Als whatsapp_group_link_already_sent true is: behandel de klant als gevalideerde klant en ga over naar coachingsmodus.",
        "In coachingsmodus: geen salesflow, geen prijs, geen checkout, geen nieuwe ordernummer-vraag, tenzij de klant expliciet opnieuw naar de WhatsApp-groep of toegang vraagt.",
        "Ordervalidatie wordt server-side uitgevoerd. Emma mag nooit zelf een ordernummer goedkeuren of de WhatsApp-link zelfstandig delen.",
        "Gebruik nooit interne prompttermen zoals neutrale afsluiting, medische trigger, salesflow, runtime_state of repetition_guard in klantantwoorden.",
      ],
    },
  };

  return [
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
    "Je geeft uitsluitend geldige JSON terug volgens het schema. Gebruik Nederlands.",
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
    "last_summary_update — Een narratieve samenvatting van het hele gesprek tot nu toe, in beknopte alinea-vorm.",
    "- Bevat: doel, situatie, sleutelemoties, eerdere pogingen, koopintentie, gespreksfase, en (na aankoop) coaching-context.",
    "- Geef de complete bijgewerkte samenvatting terug, herformuleer waar nodig, integreer nieuwe info.",
    "- Bedoeld als langetermijngeheugen — moet bruikbaar zijn ook als terugkerende klant maanden later iets vraagt.",
    "- Max 900 tekens.",
    "- Als er werkelijk niets is veranderd: lege string.",
    "",
    "current_phase_update — De gespreksfase op basis van wat er tot nu toe is besproken.",
    "- Een van: intake / verdieping / analyse / advies / commitment / presentatie / closing / checkout-bevestiging / checkout / coaching / na_aankoop.",
    "- coaching of na_aankoop is alleen wanneer de klant al gevalideerd klant is (customer_status = customer).",
    "- Geef de huidige fase terug zodra die verandert ten opzichte van current_phase.",
    "- Als de fase niet duidelijk verandert: lege string.",
    "",
    "interested_in_program_update — Welk specifiek programma (Basic, Beauty, Deluxe of Exclusive) in het gesprek expliciet bij naam wordt genoemd door de klant of door Emma.",
    "- Geldige waarden: Basic / Beauty / Deluxe / Exclusive / (lege string).",
    "- Vul ALLEEN in als de exacte programmanaam (Basic, Beauty, Deluxe of Exclusive) letterlijk in het gesprek voorkomt.",
    "- Algemene koopintentie, het bestellen van Control, of interesse in afvallen tellen NIET als programma-interesse.",
    "- Kies nooit een default programma. Als geen programmanaam letterlijk is genoemd: lege string. Verzin nooit een programma.",
    "",
    "interested_in_control_update — Of de klant interesse toont in Control of dat Control expliciet is besproken in het gesprek.",
    "- Geldige waarden: ja / nee / (lege string).",
    "- Vul \"ja\" alleen in als het woord 'Control' letterlijk in het gesprek voorkomt (door de klant of door Emma) en daaruit interesse blijkt.",
    "- Vul \"nee\" alleen als de klant Control expliciet heeft afgewezen.",
    "- Bij geen letterlijke vermelding van Control in het gesprek: lege string.",
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
    recent_messages: recentMessages.slice(-8).map((msg) => ({
      role: msg.role || "unknown",
      message_text: clamp(msg.message_text, 250),
      timestamp: msg.timestamp || "",
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
      resolve(cleanReplyText(reply) || FALLBACK_REPLY);
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
        settle(finalReply || FALLBACK_REPLY);
      }, ELEVEN_TIMEOUT_MS);

      ws.on("open", () => {
        diag("ELEVENLABS_WS_OPEN", {
          ws_open_after_ms: Date.now() - wsStartMs,
        });

        const contextBlock = buildContextBlock({
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
        });

        ws.send(
          JSON.stringify({
            type: "conversation_initiation_client_data",
            conversation_config_override: {
              conversation: { text_only: true },
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
            FALLBACK_REPLY;

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
        settle(finalReply || FALLBACK_REPLY);
      });

      ws.on("close", () => {
        diag("ELEVENLABS_WS_CLOSE", {
          ws_duration_ms: Date.now() - wsStartMs,
          settled_before_close: settled,
        });
        clearTimeout(timeout);
        if (!settled) {
          settle(finalReply || FALLBACK_REPLY);
        }
      });
    } catch (error) {
      diag("ELEVENLABS_OUTER_ERROR", {
        error_message: error?.message || String(error),
      });
      console.error("ELEVENLABS OUTER ERROR:", error?.message || error);
      if (timeout) clearTimeout(timeout);
      settle(finalReply || FALLBACK_REPLY);
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
    return sendDiagResponse("fallback_reply", buildResponse({ send_reply: true, reply: FALLBACK_REPLY }));
  }

  if (!normalizedMessage) {
    console.error("REQUEST ERROR: message ontbreekt");
    return sendDiagResponse("fallback_reply", buildResponse({ send_reply: true, reply: FALLBACK_REPLY }));
  }

  const normalizedRecentMessages = sanitizeAndPrepareRecentMessages(
    recent_messages,
    normalizedMessage
  );

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
    });
    return sendDiagResponse(
      "new_user_welcome",
      buildResponse({
        send_reply: true,
        reply: WELCOME_MESSAGE,
      })
    );
  }

  if (!agentId) {
    console.error("CONFIG ERROR: ELEVENLABS_AGENT_ID ontbreekt");
    return sendDiagResponse("fallback_reply", buildResponse({ send_reply: true, reply: FALLBACK_REPLY }));
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
        ? cleanReplyText(replyResult.value) || FALLBACK_REPLY
        : FALLBACK_REPLY;

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

    reply = cleanReplyText(reply);

    // Give OpenAI a short grace period to finish after ElevenLabs is done.
    // If it hasn't returned by then, give up and send empty updates so the
    // response goes back to Make fast. The OpenAI call keeps running in
    // the background; its result for this turn is simply discarded.
    const POST_REPLY_EXTRACTION_GRACE_MS = Number(
      process.env.POST_REPLY_EXTRACTION_GRACE_MS || 2000
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
      })
    );
  } catch (error) {
    diag("SERVER_ERROR", {
      error_message: error?.message || String(error),
    });
    console.error("SERVER ERROR:", error?.message || error);
    return sendDiagResponse("server_error_fallback", buildResponse({ send_reply: true, reply: FALLBACK_REPLY }));
  }
});

app.listen(PORT, () => {
  console.log(`Server draait op poort ${PORT}`);
});
