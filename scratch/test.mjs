async function test() {
  try {
    await fetch("invalid url");
    console.log("Success");
  } catch (e) {
    console.log("Caught:", e.message);
  }
}
test();
