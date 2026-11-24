// A test entry for tests/contacts-phone-grid.test.tsx: the real Contacts page on its own, the
// window's width, reporting where its library, loading blocks and cards' parts lie on the page
// (ContactsPage's `onPartLayout`) as `morph.fixture.event` posts ({ name, frame }).
import { host, mount, View } from "nsh";
import { configureApiBase, endpointState, localeState } from "../../lib/core/context.js";
import { boot } from "../../lib/platform";
import { ContactsPage } from "../../pages/contacts/ContactsPage";

function FixtureApp() {
  return (
    <View class="flex-1 bg-paper">
      <ContactsPage onPartLayout={(name, frame) => host.post("morph.fixture.event", { name, frame })} />
    </View>
  );
}

async function start() {
  await boot();
  configureApiBase();
  localeState.hydrateLanguage();
  endpointState.setSelectedEndpointRef("ep_console_local");
  mount(FixtureApp);
}

void start();
