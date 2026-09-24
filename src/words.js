/**
 * Fixed list of 200 common, unambiguous, lowercase English words used
 * to generate shareable box codes of the form `word-word-number`.
 *
 * Constraints:
 * - 3–8 letters, alphabetic only
 * - no profanity
 * - no homophone pairs (their/there, sun/son, flour/flower, …)
 * - no meta words (key, box, relay, token, secret)
 * - easy to read aloud and type
 *
 * Combinations: 200 × 200 × 90 (numbers 10–99) = 3,600,000
 */
export const WORDS = Object.freeze([
  "acorn", "alarm", "album", "alpha", "amber", "anchor", "anvil", "apple", "arbor", "arena",
  "armor", "arrow", "aspen", "atlas", "audio", "aurora", "autumn", "azure", "badge", "baker",
  "bamboo", "banner", "basil", "beach", "beaver", "berry", "birch", "blaze", "bloom", "breeze",
  "bridge", "bright", "bronze", "cactus", "camel", "candle", "cedar", "celery", "chalk", "chess",
  "civic", "cliff", "cloud", "comet", "coral", "cotton", "coyote", "crane", "creek", "crisp",
  "crown", "crystal", "daisy", "delta", "desert", "dolphin", "dragon", "dream", "drift", "dune",
  "eagle", "earth", "echo", "elder", "ember", "emerald", "engine", "falcon", "feather", "fence",
  "fern", "field", "finch", "flame", "flint", "forest", "fossil", "fountain", "fox", "frost",
  "garden", "geyser", "ginger", "glacier", "gleam", "globe", "goose", "grain", "grove", "harbor",
  "hazel", "hearth", "helix", "heron", "hollow", "honey", "horizon", "iceberg", "iris", "island",
  "ivory", "jade", "jaguar", "jewel", "journal", "jungle", "kelp", "kindle", "koala", "lake",
  "lemon", "lilac", "llama", "lodge", "lotus", "lunar", "maple", "marble", "meadow", "melon",
  "meteor", "mint", "mirror", "mist", "monsoon", "mountain", "nectar", "needle", "noble", "north",
  "oasis", "ocean", "olive", "onyx", "opal", "orange", "orbit", "orchid", "otter", "oyster",
  "panda", "pebble", "pelican", "planet", "polar", "poppy", "portal", "prairie", "pumpkin", "quail",
  "quilt", "rabbit", "raven", "ridge", "river", "robin", "rocket", "ruby", "saffron", "sage",
  "salmon", "scout", "shell", "shield", "silver", "slate", "solar", "spark", "spice", "spruce",
  "steam", "stone", "stream", "summit", "swan", "temple", "thistle", "thunder", "tiger", "topaz",
  "torch", "trail", "trout", "tulip", "tundra", "turtle", "valley", "velvet", "violet", "vista",
  "voyage", "walnut", "wheat", "willow", "winter", "wonder", "wool", "yellow", "zephyr", "glider",
]);

export function randomWord(rng = Math.random) {
  return WORDS[Math.floor(rng() * WORDS.length)];
}

