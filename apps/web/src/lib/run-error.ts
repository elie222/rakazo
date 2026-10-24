import { i18n } from "@lingui/core";
import type { RunErrorTranslator } from "@rakazo/core";

/** Static descriptors keep shared run-error messages in Lingui extraction. */
export const translateRunError: RunErrorTranslator = (message, values) => {
  switch (message) {
    case "Your OpenRouter":
      return i18n._({ id: "Your OpenRouter", message: "Your OpenRouter", values });
    case "Your OpenAI":
      return i18n._({ id: "Your OpenAI", message: "Your OpenAI", values });
    case "Your Anthropic":
      return i18n._({ id: "Your Anthropic", message: "Your Anthropic", values });
    case "Your model provider":
      return i18n._({ id: "Your model provider", message: "Your model provider", values });
    case "The model provider returned an error.":
      return i18n._({
        id: "The model provider returned an error.",
        message: "The model provider returned an error.",
        values,
      });
    case "{provider} is rate limiting requests. Try again shortly.":
      return i18n._({
        id: "{provider} is rate limiting requests. Try again shortly.",
        message: "{provider} is rate limiting requests. Try again shortly.",
        values,
      });
    case "{summary} Resets {date}.":
      return i18n._({
        id: "{summary} Resets {date}.",
        message: "{summary} Resets {date}.",
        values,
      });
    case "{provider} rejected the API key. Check your connection settings.":
      return i18n._({
        id: "{provider} rejected the API key. Check your connection settings.",
        message: "{provider} rejected the API key. Check your connection settings.",
        values,
      });
    case "{provider} could not find the requested model.":
      return i18n._({
        id: "{provider} could not find the requested model.",
        message: "{provider} could not find the requested model.",
        values,
      });
    case "{provider} denied access to this model.":
      return i18n._({
        id: "{provider} denied access to this model.",
        message: "{provider} denied access to this model.",
        values,
      });
    case "The model returned an unusable response. Try again.":
      return i18n._({
        id: "The model returned an unusable response. Try again.",
        message: "The model returned an unusable response. Try again.",
        values,
      });
    case "This model's context window is too small. Choose another model.":
      return i18n._({
        id: "This model's context window is too small. Choose another model.",
        message: "This model's context window is too small. Choose another model.",
        values,
      });
    case "{provider} took too long to respond. Try again.":
      return i18n._({
        id: "{provider} took too long to respond. Try again.",
        message: "{provider} took too long to respond. Try again.",
        values,
      });
    case "{provider} is overloaded right now. Try again in a moment.":
      return i18n._({
        id: "{provider} is overloaded right now. Try again in a moment.",
        message: "{provider} is overloaded right now. Try again in a moment.",
        values,
      });
    case "This conversation is too long for the model. Retrying won't help. Start a new chat or shorten your message.":
      return i18n._({
        id: "This conversation is too long for the model. Retrying won't help. Start a new chat or shorten your message.",
        message:
          "This conversation is too long for the model. Retrying won't help. Start a new chat or shorten your message.",
        values,
      });
    case "{provider} key hit its limit.":
      return i18n._({
        id: "{provider} key hit its limit.",
        message: "{provider} key hit its limit.",
        values,
      });
    case "{provider} key hit its daily limit.":
      return i18n._({
        id: "{provider} key hit its daily limit.",
        message: "{provider} key hit its daily limit.",
        values,
      });
    case "{provider} key hit its weekly limit.":
      return i18n._({
        id: "{provider} key hit its weekly limit.",
        message: "{provider} key hit its weekly limit.",
        values,
      });
    case "{provider} key hit its monthly limit.":
      return i18n._({
        id: "{provider} key hit its monthly limit.",
        message: "{provider} key hit its monthly limit.",
        values,
      });
    case "{provider} reached its credit limit.":
      return i18n._({
        id: "{provider} reached its credit limit.",
        message: "{provider} reached its credit limit.",
        values,
      });
    case "{provider} reached its daily credit limit.":
      return i18n._({
        id: "{provider} reached its daily credit limit.",
        message: "{provider} reached its daily credit limit.",
        values,
      });
    case "{provider} reached its weekly credit limit.":
      return i18n._({
        id: "{provider} reached its weekly credit limit.",
        message: "{provider} reached its weekly credit limit.",
        values,
      });
    case "{provider} reached its monthly credit limit.":
      return i18n._({
        id: "{provider} reached its monthly credit limit.",
        message: "{provider} reached its monthly credit limit.",
        values,
      });
    case "{provider} reached its spending limit.":
      return i18n._({
        id: "{provider} reached its spending limit.",
        message: "{provider} reached its spending limit.",
        values,
      });
    case "{provider} reached its daily spending limit.":
      return i18n._({
        id: "{provider} reached its daily spending limit.",
        message: "{provider} reached its daily spending limit.",
        values,
      });
    case "{provider} reached its weekly spending limit.":
      return i18n._({
        id: "{provider} reached its weekly spending limit.",
        message: "{provider} reached its weekly spending limit.",
        values,
      });
    case "{provider} reached its monthly spending limit.":
      return i18n._({
        id: "{provider} reached its monthly spending limit.",
        message: "{provider} reached its monthly spending limit.",
        values,
      });
    case "{summary} Your backup models also failed.":
      return i18n._({
        id: "{summary} Your backup models also failed.",
        message: "{summary} Your backup models also failed.",
        values,
      });
    case "{summary} No backup model was usable for this request.":
      return i18n._({
        id: "{summary} No backup model was usable for this request.",
        message: "{summary} No backup model was usable for this request.",
        values,
      });
    case "{summary} Backup models failed or were unavailable for this request.":
      return i18n._({
        id: "{summary} Backup models failed or were unavailable for this request.",
        message: "{summary} Backup models failed or were unavailable for this request.",
        values,
      });
    default:
      return message;
  }
};
