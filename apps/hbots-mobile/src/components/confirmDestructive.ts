import { Alert } from "react-native";

/**
 * One destructive yes/no. The first line of the confirm copy is the title and
 * the rest is the body, so the words stay the same as the web dialog's.
 */
export function confirmDestructive(message: string, confirmLabel: string): Promise<boolean> {
  const [title = message, ...rest] = message.split("\n");
  return new Promise((resolve) => {
    Alert.alert(
      title,
      rest.join("\n"),
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        {
          text: confirmLabel,
          style: "destructive",
          onPress: () => resolve(true),
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
