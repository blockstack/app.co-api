module.exports = {
  up: (queryInterface, Sequelize) =>
    queryInterface.createTable('MiningReviewerRankings', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER,
      },
      reportId: {
        type: Sequelize.INTEGER,
      },
      reviewerId: {
        type: Sequelize.INTEGER,
      },
      appId: {
        type: Sequelize.INTEGER,
      },
      ranking: {
        type: Sequelize.INTEGER,
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
    }),
  down: (queryInterface, Sequelize) => queryInterface.dropTable('MiningReviewerRankings'),
};
