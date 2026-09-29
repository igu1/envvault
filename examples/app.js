// Run with: envvault run -- node app.js
//
// There is no EnvVault dependency here: the process simply receives standard
// environment variables.

console.log("DATABASE_URL set:", Boolean(process.env.DATABASE_URL));
console.log("REDIS_URL set:   ", Boolean(process.env.REDIS_URL));
console.log("SECRET_KEY set:  ", Boolean(process.env.SECRET_KEY));

// Never do this in real code: it prints secret values to the terminal.
if (process.env.ENVVAULT_SHOW_VALUES === "1") {
  console.log(process.env.DATABASE_URL);
}
