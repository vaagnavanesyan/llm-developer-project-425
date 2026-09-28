"use strict";

// Маскирование персональных данных перед записью в YDB и отправкой в LLM.
// Порядок важен: сначала длинные номера (карты), потом телефоны, иначе
// номер карты частично съест шаблон телефона.
const RULES = [
  { label: "[EMAIL]", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { label: "[CARD]", pattern: /\b(?:\d[ -]?){15,18}\d\b/g },
  { label: "[SNILS]", pattern: /\b\d{3}-\d{3}-\d{3}[ -]\d{2}\b/g },
  { label: "[PASSPORT]", pattern: /\b\d{2}\s?\d{2}\s?№?\s?\d{6}\b/g },
  { label: "[PHONE]", pattern: /(?:\+7|\b8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/g },
  { label: "[INN]", pattern: /\b(?:ИНН|инн)[:\s]*\d{10,12}\b/g },
];

const maskPii = (text) => RULES.reduce((result, { label, pattern }) => result.replace(pattern, label), text || "");

module.exports = { maskPii };
