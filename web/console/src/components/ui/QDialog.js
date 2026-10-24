import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";

import { onPopupClose, opensKeyboard } from "./popup";

// QDialog: a modal dialog bound with v-model. It renders where it is used: a wrapper holding the
// trigger slot, then the mask with the dialog over the page. Clicking the mask or pressing Escape
// closes it, unless it is persistent, when the dialog shakes instead. While open it locks the
// page's scroll, keeps Tab inside, focuses its first control and gives focus back on close.
// desktopMode "popup" instead hangs it under (or above) the trigger without a mask, on desktop
// browsers only; a click elsewhere closes it. On a touch screen a first control that is a text
// field is not focused (it would raise the keyboard over the dialog); the dialog takes focus.
//
// Derived from quail-ui 0.9.10 (Apache License 2.0).
const isMobile = typeof navigator !== "undefined" && /AppleWebKit.*Mobile.*/.test(navigator.userAgent);
const FIELDS = "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])";
// What Tab cycles through, and what takes focus on open (links too).
const FOCUSABLE = `${FIELDS}, [tabindex]:not([tabindex="-1"])`;
const FIRST_FOCUS = `${FIELDS}, a[href], [tabindex]:not([tabindex="-1"])`;
let dialogSeq = 0;

const QDialog = {
  name: "QDialog",
  props: {
    modelValue: Boolean,
    desktopMode: { type: String, default: "dialog" },
    popupPosition: { type: String, default: "bottom" },
    noFrame: { type: Boolean, default: false },
    title: { type: String, default: "" },
    width: { type: String, default: "500px" },
    height: { type: String, default: "auto" },
    position: { type: String, default: "center" },
    persistent: { type: Boolean, default: false },
    class: { type: String, default: "" },
  },
  emits: ["update:modelValue", "close"],
  setup(props, { emit }) {
    const shaking = ref(false);
    const isOpen = ref(props.modelValue);
    const popupPos = ref({ top: "0", left: "0" });
    const triggerWrapper = ref(null);
    const dialogRef = ref(null);
    const titleId = `q-dialog-title-${++dialogSeq}`;
    let previousActive = null;
    let bodyOverflowY = "";
    let scrollLocked = false;
    let keydownOn = false;
    let shakeTimer = null;
    let stopPopupClose = null;

    const isDesktopPopup = computed(() => !isMobile && props.desktopMode === "popup");
    const dialogStyle = computed(() => {
      const narrow = typeof document !== "undefined" && document.body.clientWidth < 720;
      const style = { width: narrow ? "100%" : props.width, height: props.height };
      if (isDesktopPopup.value) {
        if (props.popupPosition === "top") {
          style.bottom = popupPos.value.bottom;
        } else {
          style.top = popupPos.value.top;
        }
        style.left = popupPos.value.left;
      }
      return style;
    });
    const dialogCls = computed(() =>
      [shaking.value ? "shaking" : "", isMobile ? "" : `desktop-mode-${props.desktopMode}`, props.noFrame ? "no-frame" : ""]
        .filter(Boolean)
        .join(" "),
    );
    const maskCls = computed(() => {
      const cls = [];
      if (isDesktopPopup.value) {
        cls.push("desktop-mode-popup");
      }
      if (isMobile) {
        cls.push(props.popupPosition === "top" ? "position-top" : "position-bottom");
      }
      return cls.join(" ");
    });

    function lockScroll() {
      if (scrollLocked || isDesktopPopup.value) {
        return;
      }
      bodyOverflowY = document.body.style.overflowY;
      document.body.style.overflowY = "hidden";
      scrollLocked = true;
    }
    function unlockScroll() {
      if (!scrollLocked) {
        return;
      }
      document.body.style.overflowY = bodyOverflowY;
      scrollLocked = false;
    }
    function onKeydown(event) {
      if (!isOpen.value) {
        return;
      }
      if (event.key === "Escape" && !props.persistent) {
        close();
        return;
      }
      const dialog = dialogRef.value;
      if (event.key !== "Tab" || !dialog) {
        return;
      }
      const focusable = dialog.querySelectorAll(FOCUSABLE);
      if (!focusable.length) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    function listenKeys(on) {
      if (on === keydownOn) {
        return;
      }
      window[on ? "addEventListener" : "removeEventListener"]("keydown", onKeydown);
      keydownOn = on;
    }
    function onOpen() {
      previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      lockScroll();
      listenKeys(true);
      nextTick(() =>
        requestAnimationFrame(() => {
          const dialog = dialogRef.value;
          if (dialog) {
            const first = dialog.querySelector(FIRST_FOCUS);
            (first && !opensKeyboard(first) ? first : dialog).focus();
          }
        }),
      );
    }
    function onClose() {
      unlockScroll();
      listenKeys(false);
      previousActive?.focus();
      previousActive = null;
    }
    function close() {
      if (props.persistent) {
        shaking.value = true;
        clearTimeout(shakeTimer);
        shakeTimer = setTimeout(() => {
          shaking.value = false;
          shakeTimer = null;
        }, 300);
        return;
      }
      isOpen.value = false;
      onClose();
      emit("update:modelValue", false);
      emit("close");
    }

    watch(
      () => props.modelValue,
      (value) => {
        isOpen.value = value;
        nextTick(() => {
          const trigger = triggerWrapper.value?.children?.[0];
          if (isDesktopPopup.value && trigger) {
            const offset = `${trigger.getBoundingClientRect().height + 8}px`;
            popupPos.value = props.popupPosition === "top" ? { bottom: offset, left: "0px" } : { top: offset, left: "0px" };
          }
          if (value) {
            onOpen();
          } else {
            onClose();
          }
        });
      },
    );
    onMounted(() => {
      if (props.desktopMode === "popup") {
        stopPopupClose = onPopupClose(close);
      }
      if (isOpen.value) {
        onOpen();
      }
    });
    onUnmounted(() => {
      stopPopupClose?.();
      listenKeys(false);
      unlockScroll();
      clearTimeout(shakeTimer);
    });

    return { isOpen, isDesktopPopup, dialogStyle, dialogCls, maskCls, triggerWrapper, dialogRef, titleId, close };
  },
  template: `
    <div ref="triggerWrapper" class="q-dialog-trigger-wrapper" :class="$props.class">
      <slot name="trigger" />
      <Transition v-if="isDesktopPopup">
        <div
          v-if="isOpen"
          ref="dialogRef"
          class="q-dialog"
          :style="dialogStyle"
          :class="dialogCls"
          role="dialog"
          :aria-label="title || undefined"
          tabindex="-1"
          @click.stop
        >
          <div class="q-dialog-body"><slot /></div>
        </div>
      </Transition>
    </div>
    <Transition v-if="!isDesktopPopup">
      <div v-if="isOpen" class="q-dialog-mask" :class="maskCls" @click="close">
        <div
          ref="dialogRef"
          class="q-dialog"
          :style="dialogStyle"
          :class="dialogCls"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="title ? titleId : undefined"
          tabindex="-1"
          @click.stop
        >
          <div class="q-dialog-header">
            <div v-if="title" class="q-dialog-title" :id="titleId">{{ title }}</div>
            <slot v-else name="header" />
          </div>
          <div class="q-dialog-body"><slot /></div>
        </div>
      </div>
    </Transition>
  `,
};

export default QDialog;
