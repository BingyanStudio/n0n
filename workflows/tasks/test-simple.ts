/** Simple test */
export default async function run() {
	console.log("Hello from test-simple");
	await Bun.write("simple-test.txt", "test content");
	return { done: true };
}
