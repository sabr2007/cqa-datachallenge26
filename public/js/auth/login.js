// Страница входа для жюри (login.html): проверка сессии, форма, понятные ошибки и возврат
// на исходный адрес (?next=). ?logout — выйти и показать форму. Без inline-кода и HTML-строк:
// текст попадает в документ только через textContent (CSP и Trusted Types страницы).

import { readStoredTheme } from "../theme.js";
import { safeNext } from "./next.js";

const API = Object.freeze({ me: "api/auth/me", login: "api/auth/login", logout: "api/auth/logout" });
const TIMEOUT_MS = 20_000;
const TEXT = Object.freeze({
  usernameMissing: "Введите логин.",
  passwordMissing: "Введите пароль.",
  invalid: "Неверный логин или пароль. Проверьте раскладку и Caps Lock.",
  tooMany: "Слишком много попыток входа. Подождите несколько минут.",
  network: "Не удалось связаться с сервером. Проверьте подключение и попробуйте ещё раз.",
  timeout: "Сервер не ответил вовремя. Попробуйте ещё раз.",
  server: "Сервер временно недоступен. Попробуйте ещё раз через минуту.",
  cookieBlocked: "Вход выполнен, но браузер не сохранил cookie сессии. Откройте сайт по https и разрешите cookie.",
  loggedOut: "Вы вышли. Чтобы продолжить, войдите снова.",
  comeBack: "После входа вернём вас на страницу, с которой вы пришли.",
  submit: "Войти",
  submitting: "Входим…",
  show: "Показать",
  hide: "Скрыть",
});

const root = document.getElementById("cqa-root");
const form = document.getElementById("login-form");
const username = document.getElementById("login-username");
const password = document.getElementById("login-password");
const toggle = document.getElementById("login-password-toggle");
const caps = document.getElementById("login-caps");
const submit = document.getElementById("login-submit");
const alertBox = document.getElementById("login-error");
const statusBox = document.getElementById("login-status");

const params = new URLSearchParams(window.location.search);
const next = safeNext(params.get("next"), window.location.href);
let busy = false;

root.dataset.theme = readStoredTheme();
form.addEventListener("submit", onSubmit);
toggle.addEventListener("click", togglePassword);
password.addEventListener("keyup", showCapsLock);
password.addEventListener("blur", () => { caps.hidden = true; });
for (const input of [username, password]) input.addEventListener("input", () => clearFieldError(input));
start();

async function start() {
  if (params.has("logout")) {
    await callApi(API.logout, { method: "POST" }).catch(() => null);
    forgetParam("logout");
    showStatus(TEXT.loggedOut);
    username.focus();
    return;
  }
  const state = await readState();
  if (state && (!state.auth_required || state.authenticated)) {
    window.location.replace(next);
    return;
  }
  if (params.has("next")) showStatus(TEXT.comeBack);
  username.focus();
}

async function onSubmit(event) {
  event.preventDefault();
  if (busy) return;
  hideError();
  const values = { username: username.value.trim(), password: password.value };
  const missing = [
    !values.username && fieldError(username, TEXT.usernameMissing),
    !values.password.trim() && fieldError(password, TEXT.passwordMissing),
  ].filter(Boolean);
  if (missing.length) {
    missing[0].focus();
    return;
  }
  setBusy(true);
  try {
    const response = await callApi(API.login, { method: "POST", body: values });
    const body = await readJson(response);
    if (response.ok || body?.error?.code === "auth_disabled") {
      await finishLogin();
      return;
    }
    showError(messageFor(response.status, body));
    if (response.status === 401) {
      password.focus();
      password.select();
    }
  } catch (error) {
    showError(error?.name === "TimeoutError" ? TEXT.timeout : TEXT.network);
  }
  setBusy(false);
}

/** Cookie могла не сохраниться (http без TLS, запрет cookie) — тогда не уходим в цикл входа. */
async function finishLogin() {
  const state = await readState();
  if (state && (!state.auth_required || state.authenticated)) {
    window.location.replace(next);
    return;
  }
  showError(TEXT.cookieBlocked);
  setBusy(false);
}

async function readState() {
  try {
    const response = await callApi(API.me);
    return response.ok ? await readJson(response) : null;
  } catch {
    return null;
  }
}

function callApi(path, { method = "GET", body } = {}) {
  const headers = body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" };
  return fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function messageFor(status, body) {
  const serverText = typeof body?.error?.message === "string" ? body.error.message.trim() : "";
  if (status === 401) return TEXT.invalid;
  if (status === 429) return serverText || TEXT.tooMany;
  if (status >= 500) return TEXT.server;
  return serverText || TEXT.server;
}

function fieldError(input, text) {
  const note = document.getElementById(`${input.id}-error`);
  input.setAttribute("aria-invalid", "true");
  note.textContent = text;
  note.hidden = false;
  return input;
}

function clearFieldError(input) {
  const note = document.getElementById(`${input.id}-error`);
  input.removeAttribute("aria-invalid");
  note.hidden = true;
}

function showError(text) {
  statusBox.hidden = true;
  alertBox.textContent = text;
  alertBox.hidden = false;
}

function hideError() {
  alertBox.hidden = true;
  alertBox.textContent = "";
}

function showStatus(text) {
  statusBox.textContent = text;
  statusBox.hidden = false;
}

function setBusy(value) {
  busy = value;
  form.setAttribute("aria-busy", String(value));
  submit.setAttribute("aria-disabled", String(value));
  submit.textContent = value ? TEXT.submitting : TEXT.submit;
}

function togglePassword() {
  const reveal = password.type === "password";
  password.type = reveal ? "text" : "password";
  toggle.setAttribute("aria-pressed", String(reveal));
  toggle.textContent = reveal ? TEXT.hide : TEXT.show;
}

function showCapsLock(event) {
  caps.hidden = !event.getModifierState?.("CapsLock");
}

function forgetParam(name) {
  const url = new URL(window.location.href);
  url.searchParams.delete(name);
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}
