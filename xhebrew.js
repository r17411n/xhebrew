// Content script: replace text nodes using mappings from browser.storage.local
(function () {
	const DEFAULTS = [
		{ find: "Twitter", replace: "X (Twitter)" },
		{ find: "hello", replace: "שלום" }
	];

	// Default translation settings
	const DEFAULT_TRANSLATE = {
		enabled: false,
		target: 'en',
		replace: true
	};

	function isRegexString(s) {
		return typeof s === 'string' && s.length >= 2 && s[0] === '/' && s.lastIndexOf('/') > 0;
	}

	function makeMatcher(find) {
		if (!find) return null;
		if (isRegexString(find)) {
			const lastSlash = find.lastIndexOf('/');
			const pattern = find.slice(1, lastSlash);
			const flags = find.slice(lastSlash + 1);
			try {
				return new RegExp(pattern, flags.includes('g') ? flags : flags + 'g');
			} catch (e) {
				return null;
			}
		}
		// escape for literal replacement via split/join
		return { literal: find };
	}

	function replaceInTextNode(node, mappings) {
		if (!node || !node.nodeValue) return;
		let text = node.nodeValue;
		let newText = text;
		for (const m of mappings) {
			if (!m || !m.find) continue;
			const matcher = makeMatcher(m.find);
			const replacement = m.replace ?? '';
			if (!matcher) continue;
			if (matcher.literal !== undefined) {
				// simple literal replace
				if (matcher.literal === '') continue;
				newText = newText.split(matcher.literal).join(replacement);
			} else {
				newText = newText.replace(matcher, replacement);
			}
		}
		if (newText !== text) node.nodeValue = newText;
	}

	function walkAndReplace(root, mappings) {
		if (!root) return;
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
			acceptNode(node) {
				if (!node.parentNode) return NodeFilter.FILTER_REJECT;
				const parentName = node.parentNode.nodeName;
				if (["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "OBJECT", "VIDEO"].includes(parentName)) return NodeFilter.FILTER_REJECT;
				if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
				return NodeFilter.FILTER_ACCEPT;
			}
		});

		const nodes = [];
		let n;
		while (n = walker.nextNode()) nodes.push(n);
		for (const tn of nodes) replaceInTextNode(tn, mappings);
	}

	async function loadConfig() {
		try {
			const res = await browser.storage.local.get(['mappings','translateEnabled','translateTarget','translateReplace','useCloudTranslate','googleApiKey']);
			const mappings = (res && Array.isArray(res.mappings) && res.mappings.length) ? res.mappings : DEFAULTS;
			const translate = {
				enabled: !!res.translateEnabled,
				target: (res.translateTarget || DEFAULT_TRANSLATE.target),
				replace: (res.translateReplace === undefined) ? DEFAULT_TRANSLATE.replace : !!res.translateReplace,
				useCloud: !!res.useCloudTranslate,
				apiKey: (res.googleApiKey || '')
			};
			return { mappings, translate };
		} catch (e) {
			return { mappings: DEFAULTS, translate: DEFAULT_TRANSLATE };
		}
	}

	// Simple Hebrew detection: presence of a Hebrew-range codepoint
	function containsHebrew(s) {
		return /[\u0590-\u05FF]/.test(s);
	}

	// Translation service is provided by the background service worker.
	// Content script requests translations via runtime messaging so the API key stays in the background.
	async function translateText(text, target) {
		if (!text || !target) return '';
		try {
			const resp = await browser.runtime.sendMessage({ type: 'translate', text: text, target: target });
			if (resp && typeof resp.translated === 'string') return resp.translated;
		} catch (e) {
			// fall through
		}
		return '';
	}

	// WeakMap to remember which tweet elements we've translated (to avoid repeat)
	const _translatedTweets = new WeakMap();

	// Find the tweet container element for a given node (closest ancestor that looks like a tweet)
	function findTweetContainer(node) {
		if (!node || !node.closest) return null;
		// Prefer article[role="article"] or elements with data-testid containing "tweet"
		const article = node.closest('article[role="article"]');
		if (article) return article;
		const byTestId = node.closest('[data-testid]');
		if (byTestId && /tweet/i.test(byTestId.getAttribute('data-testid'))) return byTestId;
		// fallback: closest ARTICLE tag
		const art = node.closest('article');
		if (art) return art;
		return null;
	}

	// Find the primary tweet text element inside a tweet container
	function findTweetTextElement(container) {
		if (!container) return null;
		// Common selector used on Twitter/X
		let el = container.querySelector('[data-testid="tweetText"]');
		if (el) return el;
		// fallback to first element with a lang attribute (the tweet text often has lang)
		el = container.querySelector('[lang]');
		if (el) return el;
		// last resort: first paragraph/span inside article
		el = container.querySelector('div > div > span, p, div');
		return el;
	}

	// Append a small element with the translation (preserve original formatting)
	function appendTranslationElement(tweetTextEl, translated) {
		if (!tweetTextEl || !translated) return;
		// Check if we've already appended a translation for this target text
		const existing = tweetTextEl.querySelector('.xhebrew-translation');
		if (existing) {
			existing.textContent = translated;
			return existing;
		}
		const wrap = document.createElement('div');
		wrap.className = 'xhebrew-translation';
		wrap.style.color = '#444';
		wrap.style.fontSize = '90%';
		wrap.style.marginTop = '6px';
		wrap.textContent = translated;
		tweetTextEl.appendChild(wrap);
		return wrap;
	}

	async function handleTweetElement(container, mappings, translateCfg) {
		if (!container) return;
		// apply mappings within container first
		walkAndReplace(container, mappings);

		if (!translateCfg || !translateCfg.enabled) return;

		const textEl = findTweetTextElement(container);
		if (!textEl) return;
		const text = textEl.innerText && textEl.innerText.trim();
		if (!text) return;
		if (!containsHebrew(text)) return;

		const last = _translatedTweets.get(container);
		if (last && last.text === text && last.target === translateCfg.target) return;

		const translated = await translateText(text, translateCfg.target);
		if (!translated) return;

		if (translateCfg.replace) {
			// replace text content - this will remove inline markup; trade-off for a simpler replacement
			// preserve original via data attribute
			if (!textEl.hasAttribute('data-xhebrew-original')) textEl.setAttribute('data-xhebrew-original', textEl.innerHTML);
			textEl.textContent = translated;
		} else {
			appendTranslationElement(textEl, translated);
		}

		_translatedTweets.set(container, { text, target: translateCfg.target });
	}

	async function main() {
		const cfg = await loadConfig();
		const mappings = cfg.mappings;
		const translateCfg = cfg.translate;

		// translation is performed by the background service worker; nothing to expose here in the content script

		// initial pass: find tweet containers and process each
		const tweetSelector = '[data-testid="tweetText"], article[role="article"]';
		const candidates = document.querySelectorAll(tweetSelector);
		for (const cand of candidates) {
			// normalize: if selector matched tweetText element, climb to container
			const container = cand.closest('article[role="article"]') || cand.closest('[data-testid]') || cand.closest('article') || cand.parentElement;
			await handleTweetElement(container, mappings, translateCfg);
		}

		const observer = new MutationObserver((records) => {
			for (const rec of records) {
				for (const added of rec.addedNodes) {
					if (added.nodeType === Node.ELEMENT_NODE) {
						// If an entire tweet container was added
						const maybeTweet = added.matches && (added.matches('article[role="article"]') || (added.getAttribute && /tweet/i.test(added.getAttribute('data-testid') || '')));
						if (maybeTweet) {
							handleTweetElement(added, mappings, translateCfg);
							continue;
						}
						// Otherwise, see if a tweet container exists inside the added subtree
						const inside = added.querySelector && (added.querySelector('[data-testid="tweetText"], article[role="article"]'));
						if (inside) {
							// find nearest container
							const textEl = added.querySelector('[data-testid="tweetText"]');
							const container = textEl ? (textEl.closest('article[role="article"]') || textEl.closest('[data-testid]') ) : added.closest('article[role="article"]') || added.closest('[data-testid]');
							if (container) handleTweetElement(container, mappings, translateCfg);
						}
					} else if (added.nodeType === Node.TEXT_NODE) {
						// if a text node changed, find tweet container
						const container = findTweetContainer(added.parentElement || added);
						if (container) handleTweetElement(container, mappings, translateCfg);
					}
				}
				if (rec.type === 'characterData' && rec.target) {
					const container = findTweetContainer(rec.target.parentElement || rec.target);
					if (container) handleTweetElement(container, mappings, translateCfg);
				}
			}
		});

		observer.observe(document.body, { childList: true, subtree: true, characterData: true });
		// start
		main();
	}  }()
); 