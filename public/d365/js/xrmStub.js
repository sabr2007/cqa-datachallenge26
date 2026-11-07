// Заглушка Client API (window.Xrm) на странице-макете формы. Веб-ресурс читает её через parent.Xrm —
// ровно так же, как в настоящей форме обращения. Реализована только используемая поверхность:
//   Xrm.Page.data.entity.getId / getEntityName, Xrm.Page.getAttribute(...).getValue, Xrm.Page.data.refresh,
//   Xrm.Utility.getGlobalContext().userSettings.languageId / getClientUrl,
//   Xrm.Navigation.navigateTo({ pageType: "webresource" }, { target: 2 }) и openUrl.

/** Имена веб-ресурсов решения → файлы стенда (в Dynamics их отдаёт /WebResources/<имя>). */
export const WEB_RESOURCES = Object.freeze({ "cqa_/quality/embed.html": "../embed.html" });
export const ORG_NAME = "freedomdemo";
export const ORG_LCID = 1049;
const ENTITY_NAME = "incident";
const FORM_TYPE = Object.freeze({ create: 1, update: 2 });

/**
 * @param {Window} win
 * @param {{
 *   getRecord: () => (object | null),
 *   getUser: () => { lcid: number, name: string, id: string },
 *   openDialog: (options: { url: string, title: string, width: unknown, position: number }) => Promise<void>,
 *   onRefresh: () => Promise<void>,
 * }} host
 */
export function installXrmStub(win, { getRecord, getUser, openDialog, onRefresh }) {
  const columns = Object.freeze({
    cqa_conversationid: () => getRecord()?.conversationId,
    title: () => getRecord()?.title,
    cqa_group: () => getRecord()?.groupId,
    cqa_channel: () => getRecord()?.channel,
    cqa_language: () => getRecord()?.language,
  });

  const Page = Object.freeze({
    data: Object.freeze({
      entity: Object.freeze({
        getId: () => (getRecord() ? `{${getRecord().guid}}` : ""),
        getEntityName: () => ENTITY_NAME,
        getPrimaryAttributeValue: () => getRecord()?.title ?? "",
      }),
      /** formContext.data.refresh(save): перечитывает данные записи, веб-ресурсы не пересоздаёт. */
      refresh: () => onRefresh(),
    }),
    getAttribute: (name) => (Object.hasOwn(columns, name) ? attribute(name, columns[name]) : null),
    ui: Object.freeze({ getFormType: () => (getRecord() ? FORM_TYPE.update : FORM_TYPE.create) }),
  });

  const Utility = Object.freeze({
    getGlobalContext: () => {
      const user = getUser();
      return Object.freeze({
        userSettings: Object.freeze({ languageId: user.lcid, userName: user.name, userId: `{${user.id}}` }),
        organizationSettings: Object.freeze({ uniqueName: ORG_NAME, languageId: ORG_LCID }),
        getClientUrl: () => win.location.origin,
        getVersion: () => "9.2 (макет стенда)",
      });
    },
  });

  const Navigation = Object.freeze({
    navigateTo(pageInput, navigationOptions = {}) {
      if (pageInput?.pageType !== "webresource") {
        return Promise.reject(new Error("Макет поддерживает только pageType: \"webresource\"."));
      }
      const path = WEB_RESOURCES[pageInput.webresourceName];
      if (!path) return Promise.reject(new Error(`Веб-ресурс «${pageInput.webresourceName}» не найден в решении.`));
      if (navigationOptions.target !== 2) {
        return Promise.reject(new Error("Макет открывает веб-ресурсы только в диалоге (target: 2)."));
      }
      const url = new URL(path, win.document.baseURI);
      if (typeof pageInput.data === "string" && pageInput.data !== "") url.searchParams.set("data", pageInput.data);
      return openDialog({
        url: url.href,
        title: String(navigationOptions.title ?? ""),
        width: navigationOptions.width,
        position: navigationOptions.position === 2 ? 2 : 1,
      });
    },
    openUrl(url) {
      win.open(String(url), "_blank", "noopener,noreferrer");
    },
  });

  win.Xrm = Object.freeze({ Page, Utility, Navigation });
  return win.Xrm;
}

function attribute(name, read) {
  return Object.freeze({
    getName: () => name,
    getAttributeType: () => "string",
    getValue: () => read() ?? null,
  });
}
