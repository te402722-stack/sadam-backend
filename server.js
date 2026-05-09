require('dotenv').config();
const express = require("express");
const db = require("./db");
const admin = require("firebase-admin");

const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const app = express();
app.use(express.json());
const cors = require("cors");

const allowedOrigins = [
  process.env.FRONT_URL_ADULTO,
  process.env.FRONT_URL_CUIDADOR,
  "http://localhost:5173", // Para que puedas seguir probando en tu PC
  "http://localhost:5174"
];

app.use(cors({
  origin: function (origin, callback) {
    // Si el origen está en la lista o es undefined (Postman)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      // 💡 Imprime esto en los logs de Render para saber qué URL está bloqueando
      console.log("⚠️ Origen bloqueado por CORS:", origin);
      callback(new Error("Bloqueado por SADAM-CORS"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Responder rápido a la pregunta "preflight" del navegador
app.options("*", cors());


/* =========================
   GUARDAR TOKEN
========================= */
app.post("/guardar-token", async (req, res) => {
  const { id_adulto, token } = req.body;

  try {
    await db.query(
      "UPDATE adulto_mayor SET token = ? WHERE id_adulto = ?",
      [token, id_adulto]
    );

    res.json({ ok: true });

  } catch (error) {
    res.status(500).json(error);
  }
});
/* =========================
   ENVIAR NOTIFICACIONES
========================= */
async function enviarNotificacion(token, titulo, mensaje) {

  if (!token) {
    console.log("⚠️ Token vacío");
    return;
  }

  const message = {
    notification: {
      title: titulo,
      body: mensaje
    },
    token: token
  };

  try {
    await admin.messaging().send(message);
    console.log("🔔 Notificación enviada");
  } catch (error) {
    console.log("❌ Error enviando:", error.code);

    if (error.code === "messaging/registration-token-not-registered") {
      const sql = `
        UPDATE adulto_mayor
        SET token = NULL
        WHERE token = ?
      `;
      db.query(sql, [token]);
    }
  }
}

//////
app.get("/notificaciones/:id_adulto", (req, res) => {

  const { id_adulto } = req.params;

  const sql = `
    SELECT *
    FROM notificaciones
    WHERE id_adulto = ?
    ORDER BY fecha DESC
  `;

  db.query(sql, [id_adulto], (err, result) => {

    if (err) return res.status(500).json(err);

    res.json(result);

  });

});

//MARCAR COMO LEIDA////
app.post("/notificaciones/leida", (req, res) => {

  const { id_notificacion } = req.body;

  const sql = `
    UPDATE notificaciones
    SET leida = 1
    WHERE id_notificacion = ?
  `;

  db.query(sql, [id_notificacion], (err) => {

    if (err) return res.status(500).json(err);

    res.json({ ok: true });

  });

});
/* =========================
   GENERAR CÓDIGO
========================= */
function generarCodigo() {
  const caracteres = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let codigo = "SADAM-";

  for (let i = 0; i < 5; i++) {
    codigo += caracteres.charAt(Math.floor(Math.random() * caracteres.length));
  }

  return codigo;
}

/* =========================
   LOGIN ADULTO
========================= */
app.post("/login", (req, res) => {

  const { correo, password } = req.body;

  if (!correo || !password) {
    return res.status(400).json({ mensaje: "Faltan datos" });
  }

  const sql = `
    SELECT id_usuario, nombre, correo, password, tipo_usuario
    FROM usuarios
    WHERE correo = ?
  `;

  db.query(sql, [correo], (err, result) => {

    if (err) {
      console.error(err);
      return res.status(500).json({ mensaje: "Error en servidor" });
    }

    if (result.length === 0) {
      return res.status(404).json({ mensaje: "Usuario no encontrado" });
    }

    const usuario = result[0];

    if (usuario.tipo_usuario !== "adulto") {
      return res.status(403).json({ mensaje: "No es usuario adulto" });
    }

    if (usuario.password !== password) {
      return res.status(401).json({ mensaje: "Contraseña incorrecta" });
    }

    /* 
       OBTENER DATOS DEL ADULTO
   */

    const sqlAdulto = `
      SELECT id_adulto, nombre, fecha_nacimiento, peso, altura
      FROM adulto_mayor
      WHERE id_usuario = ?
    `;

    db.query(sqlAdulto, [usuario.id_usuario], (err2, resultAdulto) => {

      if (err2) {
        console.error(err2);
        return res.status(500).json({ mensaje: "Error al obtener adulto" });
      }

      if (resultAdulto.length === 0) {
        return res.status(404).json({ mensaje: "Adulto no encontrado" });
      }

      const adulto = resultAdulto[0];

      /* 
         RESPUESTA
      */

      res.json({
        usuario: {
          id_usuario: usuario.id_usuario,
          id_adulto: adulto.id_adulto,
          nombre: usuario.nombre,
          correo: usuario.correo,
          fecha_nacimiento: adulto.fecha_nacimiento,
          peso: adulto.peso,
          altura: adulto.altura
        }
      });

    });

  });

});

/* =========================
   LOGIN CUIDADOR (DESDE USUARIOS)
========================= */
app.post("/login-cuidador", (req, res) => {

  console.log("LOGIN CUIDADOR:", req.body);

  const { correo, password } = req.body;

  if (!correo || !password) {
    return res.status(400).json({
      mensaje: "Faltan datos"
    });
  }

  // 1. Buscar cuidador
  const sqlCuidador = `
    SELECT id_cuidador, nombre, correo, password
    FROM cuidadores
    WHERE correo = ?
  `;

  db.query(sqlCuidador, [correo], (err, result) => {

    if (err) {
      console.error("ERROR LOGIN:", err);
      return res.status(500).json({ error: err.message });
    }

    if (result.length === 0) {
      return res.status(404).json({
        mensaje: "Cuidador no encontrado"
      });
    }

    const cuidador = result[0];

    if (cuidador.password !== password) {
      return res.status(401).json({
        mensaje: "Contraseña incorrecta"
      });
    }

    // 2. Buscar adulto vinculado
    const sqlAdulto = `
      SELECT am.id_adulto, am.nombre
      FROM adulto_mayor am
      JOIN adulto_cuidador ac ON am.id_adulto = ac.id_adulto
      WHERE ac.id_cuidador = ?
    `;
  

    db.query(sqlAdulto, [cuidador.id_cuidador], (err, adultoResult) => {

      if (err) {
        console.error("ERROR ADULTO:", err);
        return res.status(500).json({ error: err.message });
      }

      res.json({
        mensaje: "Login exitoso",
        cuidador: {
          id_cuidador: cuidador.id_cuidador,
          nombre: cuidador.nombre,
          correo: cuidador.correo
        },
        adulto: adultoResult[0] || null
      });

    });

  });

});

/* =========================
   OBTENER ADULTO
========================= */
app.get("/adulto/:id", (req, res) => {

  const { id } = req.params;

  const query = `
    SELECT id_adulto, nombre, fecha_nacimiento, peso, altura
    FROM adulto_mayor
    WHERE id_adulto = ?
  `;

  db.query(query, [id], (err, results) => {

    if (err) return res.status(500).json(err);

    if (results.length === 0) {
      return res.status(404).json({ mensaje: "No encontrado" });
    }

    const adulto = results[0];

    // calcular edad
    const nacimiento = new Date(adulto.fecha_nacimiento);
    const hoy = new Date();
    let edad = hoy.getFullYear() - nacimiento.getFullYear();

    const m = hoy.getMonth() - nacimiento.getMonth();
    if (m < 0 || (m === 0 && hoy.getDate() < nacimiento.getDate())) {
      edad--;
    }

    res.json({
      ...adulto,
      edad
    });

  });

});

/* =========================
   EDITAR ADULTO
========================= */
app.put("/adulto/:id", (req, res) => {

  const { id } = req.params;

  const {
    fecha_nacimiento,
    peso,
    altura,
    tipo_sangre,
    direccion,
    contacto_emergencia,
    notas_medicas
  } = req.body;

  const sql = `
    UPDATE adulto_mayor
    SET
      fecha_nacimiento = ?,
      peso = ?,
      altura = ?,
      tipo_sangre = ?,
      direccion = ?,
      contacto_emergencia = ?,
      notas_medicas = ?
    WHERE id_adulto = ?
  `;

  db.query(
    sql,
    [
      fecha_nacimiento,
      peso,
      altura,
      tipo_sangre,
      direccion,
      contacto_emergencia,
      notas_medicas,
      id
    ],
    (err) => {

      if (err) return res.status(500).json(err);

      res.json({ mensaje: "Adulto actualizado" });

    }
  );

});

/* =========================
   CREAR ADULTO
========================= */
app.post("/usuarios", (req, res) => {

  const { nombre, correo, telefono, password, fecha_nacimiento } = req.body;

  const sqlUsuario = `
    INSERT INTO usuarios 
    (nombre, correo, telefono, password, tipo_usuario, fecha_registro)
    VALUES (?, ?, ?, ?, 'adulto', NOW())
  `;

  db.query(sqlUsuario, [nombre, correo, telefono, password], (err, result) => {

    if (err) return res.status(500).json({ message: "Error usuario" });

    const id_usuario = result.insertId;

    const codigo = generarCodigo();

    const sqlAdulto = `
      INSERT INTO adulto_mayor 
      (id_usuario, nombre, fecha_nacimiento, codigo_invitacion)
      VALUES (?, ?, ?, ?)
    `;

    db.query(sqlAdulto, [id_usuario, nombre, fecha_nacimiento, codigo], (err2, result2) => {

      if (err2) return res.status(500).json({ message: "Error adulto" });

      const id_adulto = result2.insertId;

      const link = `${process.env.FRONT_URL}/registro-cuidador/${codigo}`;
      res.json({
        message: "Adulto registrado",
        id_adulto,
        codigo_invitacion: codigo,
        link_invitacion: link
      });

    });

  });

});

/* =========================
   REGISTRO CUIDADOR 
========================= */
app.post("/registro-cuidador", (req, res) => {

  const { nombre, correo, password, codigo } = req.body;

  if (!nombre || !correo || !password || !codigo) {
    return res.status(400).json({ mensaje: "Faltan datos" });
  }

  // 1. Buscar adulto por código
  const sqlBuscar = `
    SELECT id_adulto FROM adulto_mayor WHERE codigo_invitacion = ?
  `;

  db.query(sqlBuscar, [codigo], (err, result) => {

    if (err) return res.status(500).json(err);

    if (result.length === 0) {
      return res.status(404).json({ mensaje: "Código inválido" });
    }

    const id_adulto = result[0].id_adulto;

    // 2. Buscar cuidador por correo
    const sqlBuscarCuidador = `
      SELECT id_cuidador FROM cuidadores WHERE correo = ?
    `;

    db.query(sqlBuscarCuidador, [correo], (err2, cuidadores) => {

      if (err2) return res.status(500).json(err2);

      // 🔁 YA EXISTE
      if (cuidadores.length > 0) {

        const id_cuidador = cuidadores[0].id_cuidador;

        const sqlCheck = `
          SELECT * FROM adulto_cuidador
          WHERE id_adulto = ? AND id_cuidador = ?
        `;

        db.query(sqlCheck, [id_adulto, id_cuidador], (err3, existe) => {

          if (existe.length > 0) {
            return res.status(400).json({
              mensaje: "Ya estás vinculado a este adulto"
            });
          }

          const sqlRelacion = `
            INSERT INTO adulto_cuidador (id_adulto, id_cuidador, fecha_vinculacion)
            VALUES (?, ?, NOW())
          `;

          db.query(sqlRelacion, [id_adulto, id_cuidador], () => {
            res.json({ mensaje: "Vinculación exitosa" });
          });

        });

      }

      // 🆕 NO EXISTE
      else {

        const sqlNuevo = `
          INSERT INTO cuidadores (nombre, correo, password)
          VALUES (?, ?, ?)
        `;

        db.query(sqlNuevo, [nombre, correo, password], (err4, nuevo) => {

          if (err4) return res.status(500).json(err4);

          const id_cuidador = nuevo.insertId;

          const sqlRelacion = `
            INSERT INTO adulto_cuidador (id_adulto, id_cuidador, fecha_vinculacion)
            VALUES (?, ?, NOW())
          `;

          db.query(sqlRelacion, [id_adulto, id_cuidador], () => {
            res.json({ mensaje: "Cuidador registrado y vinculado" });
          });

        });

      }

    });

  });

});

/* =========================
   DASHBOARD COMPLETO
========================= */
app.get("/dashboard-completo/:idCuidador", (req, res) => {

  const { idCuidador } = req.params;

  const sql = `
    SELECT 
      am.id_adulto,
      am.nombre AS nombre_adulto,
      TIMESTAMPDIFF(YEAR, am.fecha_nacimiento, CURDATE()) AS edad,
      c.id_cuidador,
      c.nombre AS nombre_cuidador,
      c.correo
    FROM cuidadores c
    LEFT JOIN adulto_cuidador ac ON c.id_cuidador = ac.id_cuidador
    LEFT JOIN adulto_mayor am ON ac.id_adulto = am.id_adulto
    WHERE c.id_cuidador = ?
    LIMIT 1
  `;

  db.query(sql, [idCuidador], (err, result) => {

    if (err) return res.status(500).json(err);

    const row = result[0];

    const adulto = row.id_adulto ? {
      id_adulto: row.id_adulto,
      nombre: row.nombre_adulto,
      edad: row.edad
    } : null;

    const cuidador = {
      id_cuidador: row.id_cuidador,
      nombre: row.nombre_cuidador,
      correo: row.correo
    };

    res.json({
      adulto,
      cuidador,
      datos: {
        actividadesTotales: 0,
        actividadesCompletadas: 0,
        medicamentosTotales: 0,
        medicamentosTomados: 0,
        alertas: 0
      }
    });

  });

});


/* =========================
   VISUALIZAR CUIDADORES
========================= */
app.get("/adulto/:id/cuidadores", (req, res) => {
  const { id } = req.params;

  const query = `
    SELECT c.id_cuidador, c.nombre, c.correo
    FROM adulto_cuidador ac
    JOIN cuidadores c ON ac.id_cuidador = c.id_cuidador
    WHERE ac.id_adulto = ?
  `;

  db.query(query, [id], (err, results) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "Error al obtener cuidadores" });
    }

    res.json(results);
  });
});


/* =========================
   ADULTOS DE UN CUIDADOR
========================= */
app.get("/adultos-cuidador/:idCuidador", (req, res) => {

  const { idCuidador } = req.params;

  const sql = `
    SELECT 
      am.id_adulto,
      am.nombre,
      TIMESTAMPDIFF(YEAR, am.fecha_nacimiento, CURDATE()) AS edad
    FROM adulto_mayor am
    JOIN adulto_cuidador ac ON am.id_adulto = ac.id_adulto
    WHERE ac.id_cuidador = ?
  `;

  db.query(sql, [idCuidador], (err, results) => {

    if (err) {
      console.error(err);
      return res.status(500).json(err);
    }

    res.json(results);

  });

});

/* =========================
   DASHBOARD DATOS ADULTO
========================= */

app.get("/dashboard-datos/:id_adulto", (req, res) => {

  const { id_adulto } = req.params;

  const ahora = new Date();

const fecha = ahora.getFullYear() + "-" +
  String(ahora.getMonth() + 1).padStart(2, "0") + "-" +
  String(ahora.getDate()).padStart(2, "0");

const hora = String(ahora.getHours()).padStart(2, "0") + ":" +
  String(ahora.getMinutes()).padStart(2, "0") + ":" +
  String(ahora.getSeconds()).padStart(2, "0");

  const dashboard = {
    recordatorios: [],
    sintomas: [],
    actividades: [],
    estado_animo: "Sin registro"
  };

  /* RECORDATORIOS HOY */

  const sqlRecordatorios = `
  SELECT 
    tipo AS titulo,
    fecha,
    hora,
    CASE 
      WHEN completado = 1 THEN 'Completado'
      WHEN fecha < CURDATE() 
        OR (fecha = CURDATE() AND hora < CURTIME()) 
      THEN 'Retrasado'
      ELSE 'Pendiente'
    END AS estado
  FROM recordatorios
  WHERE id_adulto = ?
  AND DATE(fecha) = ?
  AND activo = 1
`;

  db.query(sqlRecordatorios, [id_adulto, fecha], (err, recordatorios) => {

    if (!err) dashboard.recordatorios = recordatorios;

    /* SINTOMAS */

    const sqlSintomas = `
      SELECT sintoma
      FROM sintomas
      WHERE id_adulto = ?
      AND DATE(fecha) = ?
    `;

    db.query(sqlSintomas, [id_adulto, fecha], (err2, sintomas) => {

      if (!err2) dashboard.sintomas = sintomas;

      /* ACTIVIDADES */

      const sqlActividades = `
        SELECT actividad as nombre, hora
        FROM actividades
        WHERE id_adulto = ?
        AND DATE(fecha) = ?
      `;

      db.query(sqlActividades, [id_adulto, fecha], (err3, actividades) => {

        if (!err3) {

          dashboard.actividades = actividades.map(a => ({
            nombre: a.nombre,
            realizada: true,
            hora: a.hora
          }));

        }

        /* ESTADO DE ANIMO */

        const sqlAnimo = `
          SELECT animo
          FROM estado_animo
          WHERE id_adulto = ?
          AND DATE(fecha) = ?
          ORDER BY hora DESC
          LIMIT 1
        `;

        db.query(sqlAnimo, [id_adulto, fecha], (err4, animo) => {

          if (!err4 && animo.length > 0) {
            dashboard.estado_animo = animo[0].animo;
          }

          res.json(dashboard);

        });

      });

    });

  });

});

/* =========================
   HISTORIAL COMPLETO ADULTO
========================= */

app.get("/historial/:idAdulto", (req, res) => {

  const { idAdulto } = req.params;

  const sql = `
    SELECT 
      'Sintoma' AS tipo,
      sintoma AS detalle,
      fecha,
      hora
    FROM sintomas
    WHERE id_adulto = ?

    UNION ALL

    SELECT
      'Animo' AS tipo,
      animo AS detalle,
      fecha,
      hora
    FROM estado_animo
    WHERE id_adulto = ?

    UNION ALL

    SELECT
      'Actividad' AS tipo,
      actividad AS detalle,
      fecha,
      hora
    FROM actividades
    WHERE id_adulto = ?

    UNION ALL

    SELECT
  'Recordatorio' AS tipo,
  tipo AS detalle,
  fecha,
  hora
FROM recordatorios
WHERE id_adulto = ?
AND activo = 1

    ORDER BY fecha DESC, hora DESC
  `;

  db.query(sql, [idAdulto, idAdulto, idAdulto, idAdulto], (err, result) => {

    if (err) {
      console.error("Error historial:", err);
      return res.status(500).json(err);
    }

    res.json(result);

  });

});

/* =========================
   CREAR RECORDATORIO
========================= */
app.post("/recordatorios", (req, res) => {

  const { id_cuidador, tipo, fecha, hora } = req.body;

  /* VALIDACIÓN */
  if (!id_cuidador || !tipo || !fecha || !hora) {
    return res.status(400).json({
      mensaje: "Faltan datos del recordatorio"
    });
  }

  /* 1️⃣ BUSCAR ADULTO DEL CUIDADOR */

  const sqlAdulto = `
    SELECT id_adulto
    FROM adulto_cuidador
    WHERE id_cuidador = ?
    LIMIT 1
  `;

  db.query(sqlAdulto, [id_cuidador], (err, result) => {

    if (err) {
      console.error("Error buscando adulto:", err);
      return res.status(500).json({
        mensaje: "Error al buscar adulto"
      });
    }

    if (result.length === 0) {
      return res.status(404).json({
        mensaje: "El cuidador no tiene un adulto vinculado"
      });
    }

    const id_adulto = result[0].id_adulto;

    /* 2️⃣ INSERTAR RECORDATORIO */

    const sqlInsert = `
      INSERT INTO recordatorios
      (id_adulto, tipo, fecha, hora, activo, completado)
      VALUES (?, ?, ?, ?, 1, 0)
    `;

    db.query(sqlInsert, [id_adulto, tipo, fecha, hora], (err2, result2) => {

      if (err2) {
        console.error("Error creando recordatorio:", err2);
        return res.status(500).json({
          mensaje: "Error al crear recordatorio"
        });
      }

      /* RESPUESTA */

      res.json({
        mensaje: "Recordatorio creado correctamente",
        recordatorio: {
          id_recordatorio: result2.insertId,
          id_adulto: id_adulto,
          tipo: tipo,
          fecha: fecha,
          hora: hora,
          completado: 0
        }
      });

    });

  });

});
/* =========================
   RECORDATORIOS POR ADULTO
========================= */
app.get("/recordatorios/:idAdulto", (req, res) => {

  const { idAdulto } = req.params;

  const sql = `
    SELECT 
      id_recordatorio,
      tipo,
      fecha,
      hora,
      completado
    FROM recordatorios
    WHERE id_adulto = ?
    AND activo = 1
    ORDER BY fecha ASC, hora ASC
  `;


  db.query(sql, [idAdulto], (err, result) => {

    if (err) {
      console.error("Error recordatorios:", err);
      return res.status(500).json(err);
    }

    res.json(result);

  });

});

/* =========================
   RECORDATORIOS DE HOY
========================= */
app.get("/recordatorios-hoy/:idAdulto", (req, res) => {

  const { idAdulto } = req.params;

  const sql = `
  SELECT 
    id_recordatorio,
    tipo,
    fecha,
    hora,
    completado
  FROM recordatorios
  WHERE id_adulto = ?
  AND fecha = CURDATE()
  AND activo = 1
  AND completado = 0
  ORDER BY hora ASC
`;

  db.query(sql, [idAdulto], (err, result) => {

    if (err) {
      console.error("Error recordatorios hoy:", err);
      return res.status(500).json(err);
    }

    res.json(result);

  });

});
/* =========================
   COMPLETAR RECORDATORIO
========================= */

app.post("/recordatorios/completar", (req, res) => {

  const { id_recordatorio, id_adulto } = req.body;

  const ahora = new Date();

const fecha = ahora.getFullYear() + "-" +
  String(ahora.getMonth() + 1).padStart(2, "0") + "-" +
  String(ahora.getDate()).padStart(2, "0");

const hora = String(ahora.getHours()).padStart(2, "0") + ":" +
  String(ahora.getMinutes()).padStart(2, "0") + ":" +
  String(ahora.getSeconds()).padStart(2, "0");

  const sqlLog = `
    INSERT INTO recordatorio_log
    (id_recordatorio, id_adulto, fecha, hora, completado)
    VALUES (?, ?, ?, ?, 1)
  `;

  db.query(sqlLog, [id_recordatorio, id_adulto, fecha, hora], (err) => {

    if (err) {
      console.error(err);
      return res.status(500).json(err);
    }

    const sqlUpdate = `
      UPDATE recordatorios
      SET completado = 1
      WHERE id_recordatorio = ?
    `;

    db.query(sqlUpdate, [id_recordatorio], (err2) => {

      if (err2) {
        console.error(err2);
        return res.status(500).json(err2);
      }

      res.json({ mensaje: "Recordatorio completado correctamente" });

    });

  });

});

/* =========================
   EDITAR RECORDATORIO
========================= */

app.put("/recordatorios/:id", (req, res) => {

  const { id } = req.params;
  const { tipo, fecha, hora } = req.body;

  const sql = `
    UPDATE recordatorios
    SET tipo = ?, fecha = ?, hora = ?
    WHERE id_recordatorio = ?
  `;

  db.query(sql, [tipo, fecha, hora, id], (err, result) => {

    if (err) {
      console.error("Error editando:", err);
      return res.status(500).json(err);
    }

    res.json({
      mensaje: "Recordatorio actualizado"
    });

  });

});

/* =========================
   ELIMINAR RECORDATORIO
========================= */

app.delete("/recordatorios/:id", (req, res) => {

  const { id } = req.params;

  const sql = `
    UPDATE recordatorios
    SET activo = 0
    WHERE id_recordatorio = ?
  `;

  db.query(sql, [id], (err) => {

    if (err) {
      console.error("Error eliminando:", err);
      return res.status(500).json(err);
    }

    res.json({
      mensaje: "Recordatorio eliminado"
    });

  });

});

/* =========================
   ELIMINAR VARIOS RECORDATORIOS
========================= */

app.post("/recordatorios/eliminar-varios", (req, res) => {

  const { ids } = req.body;

  if (!ids || ids.length === 0) {
    return res.status(400).json({
      mensaje: "No hay recordatorios seleccionados"
    });
  }

  const sql = `
    UPDATE recordatorios
    SET activo = 0
    WHERE id_recordatorio IN (?)
  `;

  db.query(sql, [ids], (err) => {

    if (err) {
      console.error(err);
      return res.status(500).json(err);
    }

    res.json({
      mensaje: "Recordatorios eliminados"
    });

  });

});
/* =========================
   GUARDAR ACTIVIDADES
========================= */
app.post("/actividades", (req, res) => {

  const { id_adulto, actividades } = req.body;

  if (!id_adulto || !actividades) {
    return res.status(400).json({
      mensaje: "Faltan datos"
    });
  }

const ahora = new Date();

const fecha = ahora.getFullYear() + "-" +
  String(ahora.getMonth() + 1).padStart(2, "0") + "-" +
  String(ahora.getDate()).padStart(2, "0");

const hora = String(ahora.getHours()).padStart(2, "0") + ":" +
  String(ahora.getMinutes()).padStart(2, "0") + ":" +
  String(ahora.getSeconds()).padStart(2, "0");

const values = actividades.map(a => [
  id_adulto,
  a.actividad,
  fecha,
  hora
]);
  const sql = `
  INSERT INTO actividades
  (id_adulto, actividad, fecha, hora)
  VALUES ?
`;

  db.query(sql, [values], (err, result) => {

    if (err) {
      console.error("Error guardando actividades:", err);
      return res.status(500).json(err);
    }

    res.json({
      mensaje: "Actividades guardadas correctamente"
    });

  });

});

/* =========================
   GUARDAR ESTADO DE ANIMO
========================= */

app.post("/animo", (req, res) => {

  const { id_adulto, animo } = req.body;

  if (!id_adulto || !animo) {
    return res.status(400).json({
      mensaje: "Faltan datos"
    });
  }

  const ahora = new Date();

const fecha = ahora.getFullYear() + "-" +
  String(ahora.getMonth() + 1).padStart(2, "0") + "-" +
  String(ahora.getDate()).padStart(2, "0");

const hora = String(ahora.getHours()).padStart(2, "0") + ":" +
  String(ahora.getMinutes()).padStart(2, "0") + ":" +
  String(ahora.getSeconds()).padStart(2, "0");

  const sql = `
    INSERT INTO estado_animo
    (id_adulto, animo, fecha, hora)
    VALUES (?, ?, ?, ?)
  `;

  db.query(sql, [id_adulto, animo, fecha, hora], (err, result) => {

    if (err) {
      console.error("Error guardando ánimo:", err);
      return res.status(500).json(err);
    }

    res.json({
      mensaje: "Estado de ánimo guardado"
    });

  });

});

/* =========================
   GUARDAR SINTOMAS
========================= */

app.post("/sintomas", (req, res) => {

  const { id_adulto, sintoma } = req.body;

  if (!id_adulto || !sintoma) {
    return res.status(400).json({
      mensaje: "Faltan datos"
    });
  }

  const ahora = new Date();

const fecha = ahora.getFullYear() + "-" +
  String(ahora.getMonth() + 1).padStart(2, "0") + "-" +
  String(ahora.getDate()).padStart(2, "0");

const hora = String(ahora.getHours()).padStart(2, "0") + ":" +
  String(ahora.getMinutes()).padStart(2, "0") + ":" +
  String(ahora.getSeconds()).padStart(2, "0");

  const sql = `
    INSERT INTO sintomas
    (id_adulto, sintoma, fecha, hora)
    VALUES (?, ?, ?, ?)
  `;

  db.query(sql, [id_adulto, sintoma, fecha, hora], (err, result) => {

    if (err) {
      console.error("Error guardando síntoma:", err);
      return res.status(500).json(err);
    }

    res.json({
      mensaje: "Síntoma guardado"
    });

  });

});


/* =========================
   RESUMEN AUTOCUIDADO
========================= */

app.get("/resumen/:id_adulto", (req, res) => {

  const { id_adulto } = req.params;

  const sqlSintomas = `
    SELECT sintoma, COUNT(*) AS total
    FROM sintomas
    WHERE id_adulto = ?
    GROUP BY sintoma
    ORDER BY total DESC
    LIMIT 1
  `;

  const sqlAnimo = `
    SELECT animo, COUNT(*) AS total
    FROM estado_animo
    WHERE id_adulto = ?
    GROUP BY animo
    ORDER BY total DESC
    LIMIT 1
  `;

  db.query(sqlSintomas, [id_adulto], (err1, resultSintomas) => {

    if (err1) {
      console.error(err1);
      return res.status(500).json(err1);
    }

    db.query(sqlAnimo, [id_adulto], (err2, resultAnimo) => {

      if (err2) {
        console.error(err2);
        return res.status(500).json(err2);
      }

      const sintomaFrecuente =
        resultSintomas.length > 0 ? resultSintomas[0].sintoma : "-";

      const animoFrecuente =
        resultAnimo.length > 0 ? resultAnimo[0].animo : "-";

      res.json({
        agua: 0,
        medicamentos: 0,
        animoFrecuente,
        sintomaFrecuente
      });

    });

  });

});

/* =========================
   ALERTAS DE RECORDATORIOS
========================= */

app.get("/alertas/:id_adulto", (req, res) => {

  const { id_adulto } = req.params;

  const sql = `
    SELECT 
      id_recordatorio,
      tipo,
      hora
    FROM recordatorios
    WHERE id_adulto = ?
    AND activo = 1
    AND completado = 0
    AND fecha = CURDATE()
    AND TIME(hora) <= TIME(NOW())
  `;

  db.query(sql, [id_adulto], (err, result) => {

    if (err) {
      console.error("Error alertas:", err);
      return res.status(500).json(err);
    }

    res.json(result);

  });

});

/* =========================
   VERIFICAR RECORDATORIOS AUTOMÁTICAMENTE
========================= */

setInterval(() => {

  console.log("⏰ Revisando recordatorios...");

  const sql = `
    SELECT r.id_recordatorio, r.tipo, r.hora, r.id_adulto, am.token
    FROM recordatorios r
    JOIN adulto_mayor am ON r.id_adulto = am.id_adulto
    WHERE r.activo = 1
    AND r.completado = 0
    AND r.notificado = 0
    AND r.fecha = CURDATE()
    AND TIME(r.hora) <= TIME(NOW())
  `;

  db.query(sql, (err, result) => {

    if (err) {
      console.error("Error verificando:", err);
      return;
    }

    result.forEach(r => {

      if (!r.token) return;

      const mensaje = `No olvides: ${r.tipo}`;

      // 🔔 1. Enviar notificación push
      enviarNotificacion(
        r.token,
        "⚠️ Recordatorio pendiente",
        mensaje
      );

      // 💾 2. Guardar en tabla notificaciones
      const sqlInsert = `
        INSERT INTO notificaciones
        (id_adulto, mensaje, tipo, fecha, leida)
        VALUES (?, ?, ?, NOW(), 0)
      `;

      db.query(sqlInsert, [
        r.id_adulto,
        mensaje,
        "recordatorio"
      ]);

      // ✅ 3. Marcar como notificado
      const sqlUpdate = `
        UPDATE recordatorios
        SET notificado = 1
        WHERE id_recordatorio = ?
      `;

      db.query(sqlUpdate, [r.id_recordatorio]);

    });

  });

}, 60000);

/* =========================
   SERVIDOR
========================= */
const PORT = process.env.PORT || 3001;

// Usamos PORT en lugar de 3001 fijo
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Servidor SADAM corriendo en el puerto ${PORT}`);
  console.log(`🌍 DB Host actual: ${process.env.DB_HOST}`);
});