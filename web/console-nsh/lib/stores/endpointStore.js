import { isEndpointSelectable, visibleEndpoints } from "../core/endpoints";
import { localStore } from "../platform";
import { reactiveRecord } from "./reactive-record.js";

const ENDPOINT_STORAGE_KEY = "mistermorph_console_endpoint_ref_v1";

const endpointState = reactiveRecord(
  { items: /** @type {any[]} */ ([]), selectedRef: "" },
  {
    saveSelectedEndpointRef() {
      localStore.setItem(ENDPOINT_STORAGE_KEY, this.selectedRef);
    },
    setSelectedEndpointRef(ref) {
      const next = typeof ref === "string" ? ref.trim() : "";
      if (!next) {
        this.selectedRef = "";
        this.saveSelectedEndpointRef();
        return;
      }

      const items = Array.isArray(this.items) ? this.items : [];
      if (items.length === 0) {
        this.selectedRef = next;
        this.saveSelectedEndpointRef();
        return;
      }

      const endpointItems = visibleEndpoints(items);
      const canSelect = endpointItems.some((item) => item.endpoint_ref === next && isEndpointSelectable(item));
      const fallback = endpointItems.find(isEndpointSelectable);
      this.selectedRef = canSelect ? next : fallback?.endpoint_ref || "";
      this.saveSelectedEndpointRef();
    },
    hydrateEndpointSelection() {
      const ref = localStore.getItem(ENDPOINT_STORAGE_KEY);
      this.selectedRef = typeof ref === "string" ? ref.trim() : "";
    },
    ensureEndpointSelection() {
      const items = Array.isArray(this.items) ? this.items : [];
      const endpointItems = visibleEndpoints(items);
      const current = this.selectedRef.trim();
      if (current && endpointItems.some((item) => item.endpoint_ref === current)) {
        return;
      }
      const selectableItems = endpointItems.filter(isEndpointSelectable);
      if (selectableItems.length === 0) {
        this.setSelectedEndpointRef("");
        return;
      }
      this.setSelectedEndpointRef(selectableItems[0].endpoint_ref);
    },
  },
);

export { endpointState };
