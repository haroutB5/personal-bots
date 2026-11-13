# Sourced by build-android.sh. Turns Firebase on when the owner's client config is on this machine,
# so a release build ships push without anyone remembering HBOTS_GOOGLE_SERVICES_JSON.
# Prints one line naming the file it uses, never its contents.
owner_google_services=$HOME/.config/hbots/google-services.json
if [[ -z ${HBOTS_GOOGLE_SERVICES_JSON:-} && -f $owner_google_services ]]; then
  export HBOTS_GOOGLE_SERVICES_JSON=$owner_google_services
fi
unset owner_google_services

if [[ -z ${HBOTS_GOOGLE_SERVICES_JSON:-} ]]; then
  echo "build-android: Firebase off, no google-services.json (push state unconfigured)"
elif [[ -f $HBOTS_GOOGLE_SERVICES_JSON ]]; then
  echo "build-android: Firebase on from $HBOTS_GOOGLE_SERVICES_JSON"
else
  echo "build-android: Firebase off, $HBOTS_GOOGLE_SERVICES_JSON does not exist (push state unconfigured)"
fi
