// Where Upload files picks from on a touch screen: Gallery (the system's photo picker) or File (the
// system's document picker, any type of file). A rounded sheet at the foot of a phone's screen (a
// dialog on a wide one), after the attachment views of phone messengers: each choice a row with a
// round coloured glyph, its name and what it opens. Choosing one closes the sheet and opens that
// picker; the scrim, Back and Escape close it and change nothing. The pickers are the platform's
// (lib/platform.ts `pickFiles` with a `source`): no app lists the device's files itself.
import { Text, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { DialogLayer, dialogIsSheet, Icon, type IconName } from "../ui";

export type AttachSource = "gallery" | "files";

export interface AttachSourceLabels {
  title: string;
  gallery: string;
  galleryHint: string;
  files: string;
  filesHint: string;
}

export const DEFAULT_ATTACH_SOURCE_LABELS: AttachSourceLabels = {
  title: "Upload Files",
  gallery: "Gallery",
  galleryHint: "Photos and images",
  files: "File",
  filesHint: "Documents and other files",
};

/** The sheet's corners: as round as the composer's ends, the top ones only on a phone's sheet. */
export function attachSourcePanelShape(sheet: boolean): string {
  return sheet ? "rounded-t-[24px]" : "max-w-sm rounded-[24px]";
}

export function AttachSourceSheet(props: {
  open: boolean;
  onClose: () => void;
  onChoose: (source: AttachSource) => void;
  labels?: AttachSourceLabels;
  testID?: string;
}) {
  const labels = () => props.labels ?? DEFAULT_ATTACH_SOURCE_LABELS;
  const testID = () => props.testID ?? "chat-attach-source";
  const choices = (): { id: AttachSource; icon: IconName; fill: string; label: string; hint: string }[] => [
    { id: "gallery", icon: "PhImage", fill: "bg-blue", label: labels().gallery, hint: labels().galleryHint },
    { id: "files", icon: "PhFile", fill: "bg-ok", label: labels().files, hint: labels().filesHint },
  ];
  return (
    <DialogLayer
      open={props.open}
      onClose={props.onClose}
      testID={testID()}
      label={labels().title}
      panelClass={`w-full items-stretch gap-3 px-3 pb-3 pt-2 ${attachSourcePanelShape(dialogIsSheet())}`}
      panelPaddingBottom={12}
    >
      {/* The sheet's handle: drawn only, Back and the scrim close it. */}
      <View class="items-center py-1" accessibilityElementsHidden>
        <View class="h-1 w-9 rounded-full bg-line" />
      </View>
      <Text role="header" class="px-2 text-base font-semibold text-foreground">
        {labels().title}
      </Text>
      <View class="overflow-hidden rounded-[20px] border border-line-faint bg-card" testID={`${testID()}-choices`}>
        <Each of={choices()} key={(choice) => choice.id}>
          {(choice, index) => (
            <BaseButton
              onPress={() => props.onChoose(choice().id)}
              accessibilityLabel={choice().label}
              testID={`${testID()}-${choice().id}`}
              class={`flex-row items-center gap-3 px-3 py-2.5 hover:bg-hover focus:bg-hover active:bg-press ${index() > 0 ? "border-t border-line-faint" : ""}`}
            >
              <View class={`size-11 items-center justify-center rounded-full ${choice().fill}`}>
                <Icon name={choice().icon} size={20} color="primary-foreground" />
              </View>
              <View class="min-w-0 flex-1 gap-0.5">
                <Text class="text-base font-medium text-foreground">{choice().label}</Text>
                <Text class="text-sm text-muted-foreground line-clamp-2">{choice().hint}</Text>
              </View>
            </BaseButton>
          )}
        </Each>
      </View>
    </DialogLayer>
  );
}
