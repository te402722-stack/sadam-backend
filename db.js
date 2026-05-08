require("dotenv").config();

const mysql = require("mysql2");

const conexion = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10
});

conexion.getConnection((err, connection) => {

  if (err) {
    console.log("❌ Error MySQL:", err);
  } else {
    console.log("✅ Conectado a Railway MySQL");
    connection.release();
  }

});

module.exports = conexion;