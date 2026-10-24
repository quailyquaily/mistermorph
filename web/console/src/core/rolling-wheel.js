// wheelStep is how far a RollingNumber wheel standing at stop `at` (on a strip of the digits run
// three times, 0 to 29) turns to show `digit`: the short way round, forward on a tie, as a
// counter's wheel does. 9 to 0 is one step on, 2 to 8 four steps back.
function wheelStep(at, digit) {
  const step = (digit - (at % 10) + 10) % 10;
  return step > 5 ? step - 10 : step;
}

export { wheelStep };
