/**
 * <product-sticky-atc>
 *
 * Desktop sticky Add to Cart bar, the body of the "Sticky Add to Cart"
 * template section (snippets/product-sticky-atc.liquid). It shows once the
 * product section's buy box (`.pv-actions`) has scrolled under the sticky
 * header (or above the viewport when there is no sticky header), hides as
 * soon as it is back in view or below, and steps aside while a drawer has
 * locked scrolling (the mini cart sets `no-scroll` on <body>). It stays up
 * over the footer: the one rule is "buy box no longer visible".
 *
 * It is a manual popover: shown, it renders in the top layer, above every
 * stacking context on the page. Browsers without the popover API fall back
 * to toggling `hidden` and `.is-visible`. Because the top layer also paints
 * over bottom-fixed overlays such as the cookie banner, the element measures
 * those (BOTTOM_OVERLAYS) and lifts the bar above them through the
 * `--pv-sticky-atc-offset` custom property.
 *
 * The bar owns no commerce logic:
 * - its option dropdowns (button + listbox, see the snippet) are filled from
 *   the product section's option lists (`.js-option-group` > `.js-option`,
 *   including the sibling colors that lib/product-configurables.js injects)
 *   and a choice is forwarded by clicking the matching option's label there,
 *   so the variant engine, the sibling redirect and the availability UI run
 *   unchanged;
 * - its Add to Cart proxies the click to the product section's primary
 *   button, so the form submit, its validations and the back-in-stock flow
 *   (lib/bag-add-to.js, lib/product-configurables.js) run unchanged;
 * - the state those legacy modules write to that section (active option,
 *   button text / disabled / classes, quantity controls visibility) is
 *   mirrored here with MutationObservers.
 *
 * The bar is live wherever the section is placed; remove the section from a
 * product template to turn it off there.
 */

/** `$breakpoint-tablet` + 1, i.e. `apply-to(tablet)` in scss/core/mixins/_media-queries.scss */
const DESKTOP_QUERY = '(min-width: 768px)';

/** Set on <body> by the mini cart (and other drawers) while they are open */
const SCROLL_LOCK_CLASS = 'no-scroll';

/**
 * The site header (snippets/header.liquid) is `position: sticky; top: 0`, so
 * the buy box is out of sight as soon as it slides under it, well before it
 * leaves the viewport. Its height is measured live (it changes with the
 * breakpoint and the search bar) and fed to the observer as a root margin.
 */
const HEADER = '#header';

/**
 * Bottom-fixed overlays the bar must not cover. Third-party, so matched by
 * id: the moma.org cookie banner is an iframe appended to <body> on load by
 * cookie-warning-external.js (snippets/cookie-banner-js.liquid), sized by
 * iFrameResize. Add the CMP root here when Usercentrics replaces it.
 */
const BOTTOM_OVERLAYS = ['#cookie-warning'];

/** Custom property the stylesheet reads for the bar's bottom offset */
const OFFSET_PROPERTY = '--pv-sticky-atc-offset';

/** Elements of the product section the bar mirrors */
const PRIMARY = {
  section: '#product',
  anchor: '.pv-actions',
  add: '.pv-add__btn',
  addText: '.js-add-to-bag-text',
  qty: '#productQuantityControls',
  optionGroup: '.js-option-group',
  optionList: '.config__options',
  option: '.js-option',
  optionLabel: 'label',
  optionInput: '.js-input',
  swatchImage: '.swatch__ir img',
  messages: '#quantityMessages',
};

/** The add-to-cart validation message inside `PRIMARY.messages` (lib/messages.js) */
const MESSAGE = {
  item: '.message',
  error: 'message--error',
};

/** Classes the variant engine puts on `.js-option` items */
const OPTION_STATE = {
  active: 'is-active',
  disabled: 'is-disabled',
  hidden: 'hide',
};

/** Classes that hide a whole option group in the product section */
const GROUP_HIDDEN_CLASSES = ['hide', 'hide-important'];

/** The bar's own hooks */
const REFS = {
  add: '[data-sticky-atc-add]',
  addText: '[data-sticky-atc-add-text]',
  qty: '[data-sticky-atc-qty]',
  messages: '[data-sticky-atc-messages]',
  select: '[data-sticky-atc-select]',
  selectButton: '[data-sticky-atc-select-btn]',
  selectValue: '[data-sticky-atc-select-value]',
  menu: '[data-sticky-atc-menu]',
  option: '[role="option"]',
  swatch: '[data-sticky-atc-swatch]',
};

/** Classes of the listbox parts the element builds */
const MENU_CLASSES = {
  open: 'is-open',
  option: 'pv-sticky-atc__option',
  optionText: 'pv-sticky-atc__option-text',
  swatch: 'pv-sticky-atc__swatch',
  swatchImage: 'has-image',
};

/** Button classes the variant engine toggles on the primary Add to Cart */
const MIRRORED_BUTTON_CLASSES = ['btn--primary', 'btn--quinary', 'disabled'];

/** Modifier the bar puts on its message slot for an error */
const MESSAGE_ERROR_CLASS = 'pv-sticky-atc__messages--error';

/** Must match the transition on `.pv-sticky-atc` in the snippet's stylesheet */
const HIDE_DURATION_MS = 250;

class ProductStickyAtc extends HTMLElement {
  /** @type {AbortController | null} */
  #abort = null;

  /** @type {MutationObserver[]} */
  #observers = [];

  /** @type {IntersectionObserver | null} */
  #intersection = null;

  /** @type {Element | null} */
  #header = null;

  /** @type {ResizeObserver | null} */
  #headerResize = null;

  /** Height of the sticky header the buy box observer is inset by */
  #headerHeight = 0;

  /** @type {ResizeObserver | null} */
  #overlayResize = null;

  /** @type {MediaQueryList | null} */
  #desktop = null;

  /** @type {number | undefined} */
  #hideTimer;

  /** @type {number | undefined} */
  #showFrame;

  #scrolledPast = false;

  #scrollLocked = false;

  #offset = 0;

  /**
   * @type {{
   *   section: ParentNode,
   *   anchor: Element | null,
   *   add: Element | null,
   *   qty: Element | null,
   * }}
   */
  #primary = {
    section: document,
    anchor: null,
    add: null,
    qty: null,
  };

  connectedCallback() {
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    const section = document.querySelector(PRIMARY.section) || document;

    this.#primary = {
      section,
      anchor: section.querySelector(PRIMARY.anchor),
      add: section.querySelector(PRIMARY.add),
      qty: section.querySelector(PRIMARY.qty),
      messages: section.querySelector(PRIMARY.messages),
    };

    if (!this.#primary.anchor || !this.#primary.add) {
      console.warn('[product-sticky-atc] product section buy box not found; the bar stays hidden.');
      return;
    }

    // A closed popover is not displayed; `hidden` only serves the fallback.
    if (this.#supportsPopover()) this.hidden = false;

    this.#desktop = window.matchMedia(DESKTOP_QUERY);
    this.#desktop.addEventListener('change', () => this.#evaluate(), { signal });

    this.querySelector(REFS.add)?.addEventListener('click', () => this.#proxyAddToCart(), { signal });

    for (const select of this.querySelectorAll(REFS.select)) {
      select.querySelector(REFS.selectButton)?.addEventListener('click', () => {
        this.#toggleMenu(select, !ProductStickyAtc.#isOpen(select));
      }, { signal });
      select.querySelector(REFS.menu)?.addEventListener('click', (event) => {
        const option = event.target instanceof Element ? event.target.closest(REFS.option) : null;
        if (option) this.#choose(select, option);
      }, { signal });
      select.addEventListener('keydown', (event) => this.#onSelectKeydown(select, event), { signal });
      select.addEventListener('focusout', (event) => {
        if (!(event.relatedTarget instanceof Node) || !select.contains(event.relatedTarget)) {
          this.#toggleMenu(select, false);
        }
      }, { signal });
    }

    document.addEventListener('pointerdown', (event) => {
      for (const select of this.#openSelects()) {
        const inside = event.target instanceof Node && select.contains(event.target);
        if (!inside) this.#toggleMenu(select, false);
      }
    }, { signal });

    this.#header = document.querySelector(HEADER);
    if (this.#header && typeof ResizeObserver === 'function') {
      this.#headerResize = new ResizeObserver(() => this.#onHeaderResize());
      this.#headerResize.observe(this.#header);
    }

    this.#scrollLocked = document.body.classList.contains(SCROLL_LOCK_CLASS);
    this.#observe(document.body, () => this.#onBodyClassChange(), {
      attributes: true,
      attributeFilter: ['class'],
    });

    // Overlays come and go as direct children of <body> (the cookie banner is
    // appended on load and leaves on dismissal); their height changes on
    // resize and, for the iframe, whenever iFrameResize re-measures it.
    this.#observe(document.body, () => this.#measureOverlays(), { childList: true });
    window.addEventListener('resize', () => this.#measureOverlays(), { signal });
    this.#measureOverlays();

    this.#mirrorButton();
    this.#mirrorQuantityVisibility();
    this.#mirrorOptions();
    this.#mirrorMessages();
    this.#observePrimary();

    this.#evaluate();
  }

  disconnectedCallback() {
    this.#abort?.abort();
    this.#abort = null;
    for (const observer of this.#observers) observer.disconnect();
    this.#observers = [];
    this.#intersection?.disconnect();
    this.#intersection = null;
    this.#headerResize?.disconnect();
    this.#headerResize = null;
    this.#overlayResize?.disconnect();
    this.#overlayResize = null;
    this.style.removeProperty(OFFSET_PROPERTY);
    this.#offset = 0;
    clearTimeout(this.#hideTimer);
    cancelAnimationFrame(this.#showFrame);
  }

  /** @returns {boolean} */
  #supportsPopover() {
    return typeof this.showPopover === 'function' && typeof this.hidePopover === 'function';
  }

  /**
   * Start or stop watching the buy box, depending on the media query and
   * whether the element is connected.
   */
  #evaluate() {
    const active = this.isConnected
      && Boolean(this.#desktop?.matches)
      && Boolean(this.#primary.anchor);

    if (active) {
      this.#observeAnchor();
      return;
    }

    this.#intersection?.disconnect();
    this.#intersection = null;
    this.#scrolledPast = false;
    this.#render();
  }

  /**
   * @returns {number} Current height of the sticky header, 0 when it is not
   *   stuck (e.g. `.is-scrolling` makes it `position: relative`)
   */
  #measureHeader() {
    if (!this.#header) return 0;
    if (getComputedStyle(this.#header).position !== 'sticky') return 0;
    return Math.max(0, Math.round(this.#header.getBoundingClientRect().height));
  }

  /**
   * Watch the buy box against the viewport minus the sticky header: the top
   * edge of the observer's root is pushed down by the header's height, so
   * "not intersecting, above the root" means "hidden under the header".
   */
  #observeAnchor() {
    if (this.#intersection) return;

    this.#headerHeight = this.#measureHeader();

    this.#intersection = new IntersectionObserver(([entry]) => {
      // Show only once the buy box has scrolled under the header / above the
      // viewport, not while it is still below (page top) or partly in view.
      const rootTop = entry.rootBounds?.top ?? this.#headerHeight;
      this.#scrolledPast = !entry.isIntersecting && entry.boundingClientRect.bottom <= rootTop;
      this.#render();
    }, { threshold: 0, rootMargin: `-${this.#headerHeight}px 0px 0px 0px` });

    this.#intersection.observe(this.#primary.anchor);
  }

  /**
   * The root margin is baked into the observer, so a header that changed
   * height gets a fresh one (its initial callback re-evaluates the buy box).
   */
  #onHeaderResize() {
    if (!this.#intersection) return;
    if (this.#measureHeader() === this.#headerHeight) return;
    this.#intersection.disconnect();
    this.#intersection = null;
    this.#observeAnchor();
  }

  /**
   * Lift the bar above whatever bottom-fixed overlay is currently showing:
   * the offset is the tallest visible overlay's height. Measured, not
   * assumed, because the cookie banner is a cross-origin iframe whose height
   * iFrameResize sets from its content.
   */
  #measureOverlays() {
    const overlays = BOTTOM_OVERLAYS
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .filter((overlay) => overlay instanceof HTMLElement);

    if (typeof ResizeObserver === 'function') {
      this.#overlayResize?.disconnect();
      this.#overlayResize = null;
      if (overlays.length) {
        this.#overlayResize = new ResizeObserver(() => this.#applyOffset(overlays));
        for (const overlay of overlays) this.#overlayResize.observe(overlay);
      }
    }

    this.#applyOffset(overlays);
  }

  /**
   * @param {Element[]} overlays - The bottom-fixed overlays currently in the DOM
   */
  #applyOffset(overlays) {
    // Layout viewport: `innerHeight` would include a horizontal scrollbar.
    const viewportBottom = document.documentElement.clientHeight;
    const offset = overlays.reduce((tallest, overlay) => {
      if (getComputedStyle(overlay).display === 'none') return tallest;
      const rect = overlay.getBoundingClientRect();
      // Only overlays anchored to the bottom edge count.
      const anchored = rect.height > 0 && rect.bottom >= viewportBottom - 1;
      return anchored ? Math.max(tallest, Math.round(viewportBottom - rect.top)) : tallest;
    }, 0);

    if (offset === this.#offset) return;
    this.#offset = offset;
    if (offset > 0) this.style.setProperty(OFFSET_PROPERTY, `${offset}px`);
    else this.style.removeProperty(OFFSET_PROPERTY);
  }

  #onBodyClassChange() {
    const locked = document.body.classList.contains(SCROLL_LOCK_CLASS);
    if (locked === this.#scrollLocked) return;
    this.#scrollLocked = locked;
    this.#render();
  }

  #render() {
    const visible = this.#scrolledPast && !this.#scrollLocked;
    if (!visible) this.#closeMenus();
    this.#setVisible(visible);
  }

  /**
   * @param {boolean} visible
   */
  #setVisible(visible) {
    if (this.#supportsPopover()) {
      const open = this.matches(':popover-open');
      try {
        if (visible && !open) this.showPopover();
        if (!visible && open) this.hidePopover();
      } catch (error) {
        console.warn('[product-sticky-atc] popover toggle failed', error);
      }
      return;
    }

    // Fallback: `hidden` keeps the bar out of flow and out of the tab order,
    // the class drives the slide. `hidden` and `.is-visible` are independent
    // (the class is dropped first, `hidden` only lands after the slide-out),
    // so a show must always restore the class, even when `hidden` is still
    // false because it interrupts a slide-out that is under way.
    clearTimeout(this.#hideTimer);
    cancelAnimationFrame(this.#showFrame);

    if (visible) {
      if (!this.hidden) {
        this.classList.add('is-visible');
        return;
      }
      this.hidden = false;
      // Two frames so the transition runs from the just-unhidden state.
      this.#showFrame = requestAnimationFrame(() => {
        this.#showFrame = requestAnimationFrame(() => this.classList.add('is-visible'));
      });
      return;
    }

    if (this.hidden) return;
    this.classList.remove('is-visible');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.#hideTimer = window.setTimeout(() => {
      this.hidden = true;
    }, reduceMotion ? 0 : HIDE_DURATION_MS);
  }

  /**
   * Click the primary button rather than submitting a second form: it may be
   * the add-to-bag submit or the back-in-stock trigger (its id is swapped by
   * the variant engine), and lib/bag-add-to.js validates on that submit.
   */
  #proxyAddToCart() {
    // Looked up live: the back-in-stock widget can move the button around.
    const primary = this.#primary.section.querySelector(PRIMARY.add);
    primary?.click();
  }

  #mirrorButton() {
    const primary = this.#primary.section.querySelector(PRIMARY.add);
    const button = this.querySelector(REFS.add);
    const text = this.querySelector(REFS.addText);
    if (!primary || !button) return;

    button.disabled = primary.disabled;
    for (const className of MIRRORED_BUTTON_CLASSES) {
      button.classList.toggle(className, primary.classList.contains(className));
    }

    const primaryText = primary.querySelector(PRIMARY.addText)?.textContent.trim();
    if (text && primaryText) text.textContent = primaryText;
  }

  #mirrorQuantityVisibility() {
    const qty = this.querySelector(REFS.qty);
    if (!qty || !this.#primary.qty) return;
    qty.classList.toggle('hidden', this.#primary.qty.classList.contains('hidden'));
  }

  /**
   * @param {string} name - Option name, e.g. "Color"
   * @returns {Element | null} The product section's group for that option
   */
  #primaryGroup(name) {
    return this.#primary.section.querySelector(`${PRIMARY.optionGroup}[data-option-name="${CSS.escape(name)}"]`);
  }

  /**
   * @param {Element} group
   * @returns {Element[]} The group's selectable option items, in order
   */
  static #groupOptions(group) {
    return Array.from(group.querySelectorAll(PRIMARY.option))
      .filter((item) => !item.classList.contains(OPTION_STATE.hidden));
  }

  /**
   * @param {Element} item - A `.js-option`
   * @returns {string} Its human-readable value
   */
  static #optionText(item) {
    const label = item.querySelector(PRIMARY.optionLabel);
    const text = label?.getAttribute('aria-label') || label?.textContent || item.getAttribute('data-option-value') || '';
    return text.trim();
  }

  /**
   * Refill every dropdown from the product section's option lists: values,
   * disabled state, the active one (and its swatch), and whether the group
   * is shown at all. A dropdown only earns its place in the bar when there
   * is a choice to make: single-value options (many products carry
   * "Color: White, Size: One Size") stay out, as does anything the section
   * hides itself.
   */
  #mirrorOptions() {
    for (const select of this.querySelectorAll(REFS.select)) {
      const name = select.getAttribute('data-sticky-atc-select') ?? '';
      const group = this.#primaryGroup(name);
      const list = group?.querySelector(PRIMARY.optionList);
      const items = group ? ProductStickyAtc.#groupOptions(group) : [];
      const groupHidden = !group
        || GROUP_HIDDEN_CLASSES.some((className) => group.classList.contains(className))
        || GROUP_HIDDEN_CLASSES.some((className) => list?.classList.contains(className))
        || items.length < 2;

      select.hidden = groupHidden;
      if (!groupHidden) ProductStickyAtc.#fillMenu(select, items);
    }
  }

  /**
   * @param {Element} item - A `.js-option`
   * @returns {string} The URL of its swatch image, if any
   */
  static #swatchSrc(item) {
    const image = item.querySelector(PRIMARY.swatchImage);
    return image?.currentSrc || image?.getAttribute('src') || '';
  }

  /**
   * @param {Element} select - The bar's dropdown wrapper
   * @param {Element[]} items - The matching `.js-option` items to offer
   */
  static #fillMenu(select, items) {
    const menu = select.querySelector(REFS.menu);
    const value = select.querySelector(REFS.selectValue);
    const swatch = select.querySelector(REFS.swatch);
    const withSwatches = Boolean(swatch);
    const active = items.find((item) => item.classList.contains(OPTION_STATE.active)) ?? null;
    const hadFocus = menu?.contains(document.activeElement) ?? false;

    if (menu) {
      menu.replaceChildren(...items.map((item) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = MENU_CLASSES.option;
        option.setAttribute('role', 'option');
        option.tabIndex = -1;
        option.setAttribute('data-value', item.getAttribute('data-option-value') ?? '');
        option.setAttribute('aria-selected', String(item === active));
        if (item.classList.contains(OPTION_STATE.disabled)) option.setAttribute('aria-disabled', 'true');

        if (withSwatches) {
          const chip = document.createElement('span');
          chip.className = MENU_CLASSES.swatch;
          chip.setAttribute('aria-hidden', 'true');
          const src = ProductStickyAtc.#swatchSrc(item);
          if (src) {
            chip.style.backgroundImage = `url("${src}")`;
            chip.classList.add(MENU_CLASSES.swatchImage);
          }
          option.append(chip);
        }

        const text = document.createElement('span');
        text.className = MENU_CLASSES.optionText;
        text.textContent = ProductStickyAtc.#optionText(item);
        option.append(text);
        return option;
      }));

      // Rebuilt while open (the variant engine re-rendered the list): keep focus inside.
      if (hadFocus) ProductStickyAtc.#selectedOption(menu)?.focus();
    }

    if (value) value.textContent = active ? ProductStickyAtc.#optionText(active) : '';

    if (swatch) {
      const src = active ? ProductStickyAtc.#swatchSrc(active) : '';
      swatch.style.backgroundImage = src ? `url("${src}")` : '';
      swatch.classList.toggle(MENU_CLASSES.swatchImage, src !== '');
    }
  }

  /**
   * @param {Element} menu
   * @returns {HTMLElement | null} The selected option, else the first enabled one
   */
  static #selectedOption(menu) {
    return menu.querySelector(`${REFS.option}[aria-selected="true"]`)
      || menu.querySelector(`${REFS.option}:not([aria-disabled="true"])`);
  }

  /**
   * @param {Element} select
   * @returns {boolean}
   */
  static #isOpen(select) {
    return select.classList.contains(MENU_CLASSES.open);
  }

  /** @returns {Element[]} */
  #openSelects() {
    return Array.from(this.querySelectorAll(`${REFS.select}.${MENU_CLASSES.open}`));
  }

  #closeMenus() {
    for (const select of this.#openSelects()) this.#toggleMenu(select, false);
  }

  /**
   * @param {Element} select - The bar's dropdown wrapper
   * @param {boolean} open
   */
  #toggleMenu(select, open) {
    const button = select.querySelector(REFS.selectButton);
    const menu = select.querySelector(REFS.menu);
    if (!button || !menu || ProductStickyAtc.#isOpen(select) === open) return;

    if (open) this.#closeMenus();

    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    select.classList.toggle(MENU_CLASSES.open, open);

    if (open) {
      ProductStickyAtc.#selectedOption(menu)?.focus();
    } else if (menu.contains(document.activeElement)) {
      button.focus();
    }
  }

  /**
   * Listbox keyboard support: arrows open the menu and move between options,
   * Home/End jump, Enter/Space choose, Escape closes, Tab leaves and closes.
   *
   * @param {Element} select - The bar's dropdown wrapper
   * @param {KeyboardEvent} event
   */
  #onSelectKeydown(select, event) {
    const button = select.querySelector(REFS.selectButton);
    const menu = select.querySelector(REFS.menu);
    if (!button || !menu) return;

    const open = ProductStickyAtc.#isOpen(select);
    const options = Array.from(menu.querySelectorAll(`${REFS.option}:not([aria-disabled="true"])`));
    const index = options.indexOf(document.activeElement);
    const focusAt = (position) => options[(position + options.length) % options.length]?.focus();

    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        if (!open) this.#toggleMenu(select, true);
        else focusAt(index + (event.key === 'ArrowDown' ? 1 : -1));
        break;
      case 'Home':
      case 'End':
        if (!open) return;
        event.preventDefault();
        focusAt(event.key === 'Home' ? 0 : options.length - 1);
        break;
      case 'Enter':
      case ' ':
        // On the trigger the button's own activation toggles the menu.
        if (open && index >= 0) {
          event.preventDefault();
          this.#choose(select, options[index]);
        }
        break;
      case 'Escape':
        if (!open) return;
        event.preventDefault();
        this.#toggleMenu(select, false);
        button.focus();
        break;
      case 'Tab':
        if (open) this.#toggleMenu(select, false);
        break;
      default:
    }
  }

  /**
   * @param {Element} select - The bar's dropdown wrapper
   * @param {Element} option - The chosen listbox option
   */
  #choose(select, option) {
    if (option.getAttribute('aria-disabled') === 'true') return;
    const value = option.getAttribute('data-value') ?? '';
    this.#toggleMenu(select, false);
    this.#forward(select, value);
    // The forwarded click lands on a hidden radio and drops focus on <body>.
    select.querySelector(REFS.selectButton)?.focus();
  }

  /**
   * Forward a choice to the product section by clicking the matching
   * option's label: the radio behind it is `display: none`, so nothing gains
   * focus or scrolls, and the variant engine handles the change as a click.
   *
   * @param {Element} select - The bar's dropdown wrapper
   * @param {string} value - The `data-option-value` of the chosen option
   */
  #forward(select, value) {
    const name = select.getAttribute('data-sticky-atc-select') ?? '';
    const group = this.#primaryGroup(name);
    const target = group
      ? ProductStickyAtc.#groupOptions(group).find((item) => item.getAttribute('data-option-value') === value)
      : null;

    if (!target || target.classList.contains(OPTION_STATE.disabled)) {
      this.#mirrorOptions();
      return;
    }

    const label = target.querySelector(PRIMARY.optionLabel);
    if (label) {
      label.click();
      return;
    }

    const input = target.querySelector(PRIMARY.optionInput);
    if (input && !input.checked) {
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  #observePrimary() {
    const button = this.#primary.section.querySelector(PRIMARY.add);
    if (button) {
      this.#observe(button, () => this.#mirrorButton(), {
        attributes: true,
        attributeFilter: ['disabled', 'class'],
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    if (this.#primary.qty) {
      this.#observe(this.#primary.qty, () => this.#mirrorQuantityVisibility(), {
        attributes: true,
        attributeFilter: ['class'],
      });
    }

    // Option items are inserted / re-ordered / toggled in place by the
    // variant engine; swatch images get their src swapped by lazy loading.
    for (const group of this.#primary.section.querySelectorAll(PRIMARY.optionGroup)) {
      this.#observe(group, () => this.#mirrorOptions(), {
        attributes: true,
        attributeFilter: ['class', 'src'],
        childList: true,
        subtree: true,
      });
    }

    // lib/messages.js writes the message markup, slides the container open
    // (inline style) and empties it after sliding it shut.
    if (this.#primary.messages) {
      this.#observe(this.#primary.messages, () => this.#mirrorMessages(), {
        attributes: true,
        attributeFilter: ['style'],
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
  }

  /**
   * @param {Node} target
   * @param {MutationCallback} callback
   * @param {MutationObserverInit} options
   */
  #observe(target, callback, options) {
    const observer = new MutationObserver(callback);
    observer.observe(target, options);
    this.#observers.push(observer);
  }

  /**
   * The proxied add-to-cart is validated by lib/bag-add-to.js (stock, purchase
   * limits, purchasability), which renders its verdict under the buy box, i.e.
   * off-screen whenever the bar is up. Repeat it under the bar's button so the
   * click never looks ignored; the live region announces it as well.
   */
  #mirrorMessages() {
    const source = this.#primary.messages;
    const slot = this.querySelector(REFS.messages);
    if (!source || !slot) return;

    // lib/messages.js opens the container by sliding its inline height up from
    // 0 and "clears" it by sliding the height back to 0; the markup itself is
    // never removed, so the collapsed height is the cleared state.
    const message = source.querySelector(MESSAGE.item);
    const text = message?.textContent.trim() || '';
    const collapsed = source.style.display === 'none' || parseFloat(source.style.height) === 0;
    const shown = text !== '' && !collapsed;

    slot.textContent = shown ? text : '';
    slot.classList.toggle(MESSAGE_ERROR_CLASS, shown && message.classList.contains(MESSAGE.error));
    slot.hidden = !shown;
  }
}

if (!customElements.get('product-sticky-atc')) {
  customElements.define('product-sticky-atc', ProductStickyAtc);
}
