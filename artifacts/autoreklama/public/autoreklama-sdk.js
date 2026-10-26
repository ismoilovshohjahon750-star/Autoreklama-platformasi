(function (window, document) {
  "use strict";

  var script = document.currentScript;
  var defaultApiBase =
    script && script.src
      ? new URL("/api", script.src).toString()
      : new URL("/api", window.location.origin).toString();
  var deviceStorageKey = "autoreklama-device-v1";

  function trimSlash(value) {
    return String(value || "").replace(/\/+$/, "");
  }

  function deviceToken() {
    try {
      var existing = window.localStorage.getItem(deviceStorageKey);
      if (existing) return existing;
      var value =
        window.crypto && typeof window.crypto.randomUUID === "function"
          ? window.crypto.randomUUID()
          : "ar-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
      window.localStorage.setItem(deviceStorageKey, value);
      return value;
    } catch (_error) {
      return "ar-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    }
  }

  function safeTargetUrl(value) {
    try {
      var url = new URL(value, window.location.href);
      return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
    } catch (_error) {
      return null;
    }
  }

  function sendEvent(apiBase, type, payload) {
    return window.fetch(apiBase + "/sdk/" + type, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  function createElement(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  function mount(options) {
    options = options || {};
    var placementKey = String(options.placementKey || "").trim();
    var target =
      options.element ||
      (options.selector ? document.querySelector(options.selector) : null);
    var apiBase = trimSlash(options.apiBase || defaultApiBase);

    if (!placementKey || !target) {
      return Promise.reject(
        new Error("Autoreklama SDK requires a placementKey and a target element."),
      );
    }
    if (target.getAttribute("data-autoreklama-mounted") === "true") {
      return Promise.resolve(target);
    }
    target.setAttribute("data-autoreklama-mounted", "true");

    var query = new URLSearchParams({ placementKey: placementKey });
    return window
      .fetch(apiBase + "/sdk/ads?" + query.toString(), {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        headers: { Accept: "application/json" },
      })
      .then(function (response) {
        if (!response.ok) throw new Error("Ad request failed (" + response.status + ").");
        return response.json();
      })
      .then(function (result) {
        if (!result || !result.ad) {
          target.removeAttribute("data-autoreklama-mounted");
          return null;
        }

        var ad = result.ad;
        var destination = safeTargetUrl(ad.targetUrl);
        if (!destination || !ad.clickToken) {
          target.removeAttribute("data-autoreklama-mounted");
          return null;
        }

        var device = deviceToken();
        var payload = {
          placementKey: placementKey,
          campaignId: ad.campaignId,
          clickToken: ad.clickToken,
          deviceToken: device,
          pageUrl: window.location.href,
        };
        var card = createElement(
          "article",
          "autoreklama-card",
          "",
        );
        card.style.cssText =
          "box-sizing:border-box;max-width:640px;margin:0 auto;overflow:hidden;border:1px solid #e4e1d8;border-radius:16px;background:#fffefa;color:#22283a;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;";

        if (ad.imageUrl) {
          var imageUrl = safeTargetUrl(ad.imageUrl);
          if (imageUrl) {
            var image = createElement("img", "autoreklama-card__image");
            image.src = imageUrl;
            image.alt = "";
            image.loading = "lazy";
            image.style.cssText =
              "display:block;width:100%;max-height:260px;object-fit:cover;";
            card.appendChild(image);
          }
        }

        var content = createElement("div", "autoreklama-card__content");
        content.style.cssText = "padding:20px;";
        var label = createElement(
          "p",
          "autoreklama-card__label",
          "Sponsored",
        );
        label.style.cssText =
          "margin:0 0 8px;color:#315f52;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;";
        var headline = createElement(
          "h3",
          "autoreklama-card__headline",
          ad.headline || "",
        );
        headline.style.cssText =
          "margin:0;font-size:22px;line-height:1.2;font-weight:750;letter-spacing:-.03em;";
        var body = createElement(
          "p",
          "autoreklama-card__body",
          ad.body || "",
        );
        body.style.cssText =
          "margin:10px 0 0;color:#626671;line-height:1.65;";
        var link = createElement(
          "a",
          "autoreklama-card__link",
          "Visit advertiser",
        );
        link.href = destination;
        link.target = "_blank";
        link.rel = "sponsored noopener noreferrer";
        link.style.cssText =
          "display:inline-flex;margin-top:18px;padding:10px 14px;border-radius:9px;background:#22283a;color:#fff;text-decoration:none;font-weight:700;";
        link.addEventListener("click", function () {
          sendEvent(apiBase, "clicks", payload).catch(function () {});
        });

        content.appendChild(label);
        content.appendChild(headline);
        if (ad.body) content.appendChild(body);
        content.appendChild(link);
        card.appendChild(content);
        target.replaceChildren(card);

        var impressionSent = false;
        function recordImpression() {
          if (impressionSent) return;
          impressionSent = true;
          sendEvent(apiBase, "impressions", payload).catch(function () {});
        }

        if ("IntersectionObserver" in window) {
          var observer = new IntersectionObserver(
            function (entries) {
              if (entries.some(function (entry) { return entry.isIntersecting; })) {
                recordImpression();
                observer.disconnect();
              }
            },
            { threshold: 0.5 },
          );
          observer.observe(card);
        } else {
          recordImpression();
        }
        return card;
      })
      .catch(function (error) {
        target.removeAttribute("data-autoreklama-mounted");
        if (window.console && typeof window.console.warn === "function") {
          window.console.warn("[Autoreklama] Could not load an ad.", error);
        }
        return null;
      });
  }

  window.Autoreklama = window.Autoreklama || {};
  window.Autoreklama.mount = mount;

  if (script && script.dataset.placementKey && script.dataset.target) {
    var autoMount = function () {
      mount({
        placementKey: script.dataset.placementKey,
        selector: script.dataset.target,
        apiBase: script.dataset.apiBase || defaultApiBase,
      }).catch(function () {});
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", autoMount, { once: true });
    } else {
      autoMount();
    }
  }
})(window, document);
