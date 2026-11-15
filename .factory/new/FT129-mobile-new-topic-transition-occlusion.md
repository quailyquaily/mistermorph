# Mobile new-topic slide transition fails to cover the topic list

## factory · 2026-11-15 15:57

Owner request:
> On the mobile view, when you click the plus button at the topics list page, it will slide in the new topic page. However it seems the new topic page has no bg color or its z-index is lower than the topic list page, during the sliding transition, the content of the topic list page doesn't be covered by the new topic page. Need to inspect and fix.
> Put to new/

Reproduction:
- Open the topic list on a mobile viewport with visible list content.
- Tap the plus button to open the new-topic page.
- During the slide-in, the underlying topic-list content remains visible in the area that should already be covered by the incoming page.

Requirements and acceptance criteria:
- Inspect the incoming page surface/background, transition wrapper, clipping, and stacking contexts/z-index to establish the actual cause; transparency and incorrect stacking are hypotheses, not confirmed diagnoses.
- Throughout the transition, every area occupied by the incoming new-topic page must cover the outgoing topic-list content with the intended theme-appropriate page surface. The not-yet-covered part of the outgoing page may remain visible as expected for a slide transition.
- Preserve the intended slide motion, safe-area layout, topbar/composer presentation, and navigation behavior. Fix the page/transition surface rather than removing the animation or indiscriminately raising unrelated z-index values.
- Check intermediate animation frames, not only the settled page; cover light/dark themes, narrow mobile screens, return navigation, and reduced-motion behavior. Avoid desktop regressions.
- Add appropriate regression coverage for page-surface opacity and stacking during the transition, and record any mobile visual checks that could not be performed.
